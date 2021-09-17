import { applyPatch } from 'fast-json-patch';

import { ConnectionItem } from './api/connections';

// From rd to clash
const TypeMap = {
  shadowsocks: 'Shadowsocks',
  select: 'Selector',
}
type ConfigNet = { type: 'select', list: string[], selected: number }
  | { type: 'local' }
  | { type: 'noop' }
type ConfigBody = {
  net: Record<string, ConfigNet>,
}
type ConnectionBody = {
  total_upload: number,
  total_download: number,
  connections: Record<string, {
    protocol: 'tcp' | 'udp',
    addr: string,
    start_time: number,
    ctx: {
      src_socket_addr?: string,
      dest_socket_addr?: string,
      dest_domain?: string,
      net_list: string[]
    },
    upload: number,
    download: number,
  }>
};
type ConnectionResp = { full: ConnectionBody, patch: undefined } | { full: undefined, patch: any[] };
type ExtendFunc<T> = T extends (...args: infer A) => infer R ? (opts: {
  origin: T,
  next: () => ReturnType<T>,
}, ...args: A) => R : never;
export const hookFunction = <T, K extends keyof T>(object: T, method: K, newMethod: ExtendFunc<T[K]>) => {
  const originMethod = object[method];
  if (typeof originMethod !== 'function') {
    throw new Error(`${method} is not a function`);
  }
  object[method] = function (this: any, ...args: any[]) {
    return newMethod.call(this, {
      origin: originMethod as any,
      next: () => originMethod.apply(this, args),
    }, ...args);;
  } as any;
  return
};

const parseAddress = (s: string) => {
  const idx = s.lastIndexOf(':');
  if (idx === -1) {
    throw new TypeError('Invalid address');
  }
  const host = s.slice(0, idx);
  const port = s.slice(idx + 1);
  return { host, port };
}

const WsType = new WeakMap<WebSocket, 'connections' | 'traffic' | undefined>();
const LastFull = new WeakMap<WebSocket, ConnectionBody>();
const LastTotal = new WeakMap<WebSocket, { total_upload: number, total_download: number }>();
const OriginWebsocket = WebSocket;
const rdConn2Traffic = (self: WebSocket, resp: ConnectionResp) => {
  const last = LastFull.get(self)
  let conn: ConnectionBody;
  if (resp.patch && last) {
    conn = applyPatch(last, resp.patch).newDocument;
  } else if (resp.full) {
    conn = resp.full;
  } else {
    console.log(resp, last)
    throw new TypeError('Wrong state');
  }
  LastFull.set(self, conn);

  const lastTotal = LastTotal.get(self);
  LastTotal.set(self, {
    total_download: conn.total_download,
    total_upload: conn.total_upload,
  });
  if (!lastTotal) {
    return { up: 0, down: 0 }
  }

  return {
    up: conn.total_upload - lastTotal.total_upload,
    down: conn.total_download - lastTotal.total_download,
  }
}
const rdConn2ClashConn = (self: WebSocket, resp: ConnectionResp) => {
  const last = LastFull.get(self)
  let conn: ConnectionBody;
  if (resp.patch && last) {
    conn = applyPatch(last, resp.patch).newDocument;
  } else if (resp.full) {
    conn = resp.full;
  } else {
    console.log(resp, last)
    throw new TypeError('Wrong state');
  }
  LastFull.set(self, conn);

  const clashData: {
    downloadTotal: number,
    uploadTotal: number,
    connections: ConnectionItem[],
  } = {
    downloadTotal: conn.total_download,
    uploadTotal: conn.total_upload,
    connections: Object.entries(conn.connections).map(([key, {
      protocol,
      ctx,
      addr,
      upload,
      download,
      start_time
    }]) => {
      const src = parseAddress(ctx.src_socket_addr);
      const dst = parseAddress(addr);
      const [server, ...list] = ctx.net_list;

      return {
        id: key,
        upload: upload,
        download: download,
        start: new Date(start_time * 1000).toUTCString(),
        chains: list.reverse(),
        metadata: {
          network: protocol,
          type: server as any,
          sourceIP: src.host,
          sourcePort: src.port,
          destinationIP: dst.host,
          destinationPort: dst.port,
          host: ctx.dest_domain ? parseAddress(ctx.dest_domain).host : dst.host,
        },
        rule: 'RabbitDigger'
      }
    }),
  };

  return clashData;
}
window.WebSocket = new Proxy(OriginWebsocket, {
  construct(Target, [url, protocol]) {
    const newUrl = new URL(url);
    let type = undefined;
    if (newUrl.pathname === '/connections') {
      newUrl.pathname = '/api/connection';
      newUrl.search = '?patch=true';
      type = 'connections';
    }
    if (newUrl.pathname === '/traffic') {
      newUrl.pathname = '/api/connection';
      newUrl.search = '?without_connections=true';
      type = 'traffic';
    }
    const self = new Target(newUrl, protocol);
    WsType.set(self, type);

    return self;
  }
});
hookFunction(OriginWebsocket.prototype, 'addEventListener', function (this: WebSocket, { next, origin }, event, callback) {
  const { pathname } = new URL(this.url);
  if (pathname === '/api/connection' && event === 'message') {
    return origin.call(this, 'message', (e: MessageEvent) => {
      if (typeof callback === 'function') {
        if (WsType.get(this) === 'connections') {
          const resp = rdConn2ClashConn(this, JSON.parse(e.data));
          callback({ data: JSON.stringify(resp) } as any);
        } else if (WsType.get(this) === 'traffic') {
          const resp = rdConn2Traffic(this, JSON.parse(e.data))
          callback({ data: JSON.stringify(resp) } as any);
        }
      }
    });
  }
  return next()
});

const convertProxies = (config: ConfigBody) => {
  const net = { ...config.net }
  if (!net.local) {
    net.local = {
      type: 'local',
    }
  }
  if (!net.noop) {
    net.noop = {
      type: 'noop',
    }
  }
  return Object.fromEntries(
    Object.entries(net)
      .map(([key, p]) => {
        const { type } = p
        if (p.type === 'select') {
          return {
            name: key,
            type: 'Selector',
            history: [],
            all: p.list,
            now: p.list[p.selected],
          }
        }
        return {
          name: key,
          type: TypeMap[type] || type,
          history: [],
        }
      })
      .map(i => [i.name, i])
  )
}
interface HookItem {
  test: (url: string, method?: string) => boolean
  replace: (url: string, body?: string) => Promise<string>
}
const ConfigMap = new Map<string, ConfigBody>();
const HookMap: HookItem[] = [{
  test: (url: string) => new URL(url).pathname === '/configs',
  replace: async () => JSON.stringify({
    port: 0,
    'socks-port': 0,
    'redir-port': 0,
    'tproxy-port': 0,
    'mixed-port': 114514,
    authentication: [],
    'allow-lan': false,
    'bind-address': '*',
    mode: 'rule',
    'log-level': 'silent',
    ipv6: false,
  }),
}, {
  test: (url: string) => new URL(url).pathname === '/rules',
  replace: async () => JSON.stringify({
    rules: [{
      type: 'Match',
      payload: 'RabbitDigger规则不支持查看',
      proxy: 'RabbitDigger',
    }],
  }),
}, {
  test: (url: string) => new URL(url).pathname === '/proxies',
  replace: async (url) => {
    const uo = new URL(url);
    uo.pathname = '/api/config'
    const config: ConfigBody = await (await fetch(uo.toString())).json();
    ConfigMap.set(uo.origin, config)
    const resp = {
      proxies: convertProxies(config),
    }
    console.log('proxies', resp)
    return JSON.stringify(resp)
  },
}, {
  test: (url: string) => new URL(url).pathname === '/providers/proxies',
  replace: async (url) => {
    const uo = new URL(url);
    uo.pathname = '/api/config'
    const config: ConfigBody = await (await fetch(uo.toString())).json();
    const proxy = convertProxies(config);
    const selector = Object.values(proxy).filter(i => i.type === 'Selector')
    const resp = {
      providers: {
        default: {
          name: 'default',
          proxies: Object.values(proxy),
          type: 'Proxy',
          vehicleType: "Compatible",
        },
        ...Object.fromEntries(selector.map(i => [i.name, ({
          name: i.name,
          proxies: i.all.map(k => proxy[k]),
          type: 'Proxy',
          vehicleType: "Compatible",
        })])),
      },
    };
    console.log('providers', resp, selector)
    return JSON.stringify(resp)
  },
}, {
  test: (url: string, method) => method === 'PUT' && /\/proxies\/(.*)/.test(url),
  replace: async (url, body) => {
    const { name } = JSON.parse(body)
    const net_name = /\/proxies\/(.*)/.exec(url)[1]
    const uo = new URL(url);
    const config = ConfigMap.get(uo.origin)
    const opt = config.net[net_name]
    if (opt.type !== 'select') throw new Error('select not select')
    uo.pathname = '/api/net'
    await fetch(uo.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        net_name,
        opt: {
          ...opt,
          selected: opt.list.indexOf(name),
        },
      }),
    });
    return ''
  }
}]

hookFunction(window, 'fetch', async ({ next }, url, { method, body } = {}) => {
  if (typeof url === 'string') {
    for (const { test, replace } of HookMap) {
      if (test(url, method)) {
        return new Response(await replace(url, body as string))
      }
    }
  }
  return await next()
})
