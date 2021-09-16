import { applyPatch } from 'fast-json-patch';

import { ConnectionItem } from './api/connections';

type ConnectionBody = Record<string, {
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
}>;
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

const LastFull = new WeakMap<WebSocket, ConnectionBody>();
const OriginWebsocket = WebSocket;
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
    downloadTotal: 0,
    uploadTotal: 0,
    connections: Object.entries(conn).map(([key, {
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
    if (newUrl.pathname === '/connections') {
      newUrl.pathname = '/api/connection';
      newUrl.search = '?patch=true';
    }
    console.log('new ws', url);

    return new Target(newUrl, protocol);
  }
});
hookFunction(OriginWebsocket.prototype, 'addEventListener', function (this: WebSocket, { next, origin }, event, callback) {
  const { pathname } = new URL(this.url);
  if (pathname === '/api/connection' && event === 'message') {
    return origin.call(this, 'message', (e: MessageEvent) => {
      if (typeof callback === 'function') {
        const resp = rdConn2ClashConn(this, JSON.parse(e.data));
        callback({ data: JSON.stringify(resp) } as any);
      }
    });
  }
  return next()
});
hookFunction(window, 'fetch', async ({ next }, url) => {
  if (typeof url === 'string') {
    const urlObj = new URL(url);
    if (urlObj.pathname === '/configs') {
      return new Response(JSON.stringify({
        "port": 0,
        "socks-port": 0,
        "redir-port": 0,
        "tproxy-port": 0,
        "mixed-port": 114514,
        "authentication": [],
        "allow-lan": false,
        "bind-address": "*",
        "mode": "rule",
        "log-level": "silent",
        "ipv6": false
      }));
    } else if (urlObj.pathname === '/rules') {
      return new Response(JSON.stringify({
        "rules": [{
          "type": "Match",
          "payload": "RabbitDigger规则不支持查看",
          "proxy": "RabbitDigger",
        }]
      }));
    }
  }
  return next()
});