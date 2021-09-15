import { ConnectionItem } from './api/connections';

type ConnectionResp = Record<string, {
  protocol: 'tcp' | 'udp',
  addr: string,
  start_time: number,
  ctx: {
    source_address?: string,
    net_list: string[]
  },
  upload: number,
  download: number,
}>;
type ExtendFunc<T> = T extends (this: infer S, ...args: infer A) => infer R ? (opts: {
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

const CLOSED = new WeakMap<WebSocket, boolean>();
hookFunction(WebSocket.prototype, 'close', function (this: WebSocket) {
  CLOSED.set(this, true);
});
hookFunction(WebSocket.prototype, 'addEventListener', function (this: WebSocket, { next }, event, callback) {
  const { pathname, protocol, host } = new URL(this.url);
  if (pathname === '/connections' && event === 'message') {
    const poll = async () => {
      const resp = await fetch(`${protocol.replace('ws', 'http')}//${host}/api/connection`);
      const conn: ConnectionResp = await resp.json();
      const clashData: {
        downloadTotal: number,
        uploadTotal: number,
        connections: ConnectionItem[],
      } = {
        downloadTotal: 0,
        uploadTotal: 0,
        connections: Object.entries(conn).map(([key, value]) => {
          const src = parseAddress(value.ctx.source_address);
          const dst = parseAddress(value.addr);

          return {
            id: key,
            upload: value.upload,
            download: value.download,
            start: new Date(value.start_time * 1000).toUTCString(),
            chains: value.ctx.net_list.reverse(),
            metadata: {
              network: value.protocol,
              type: 'Unknown',
              sourceIP: src.host,
              sourcePort: src.port,
              destinationIP: dst.host,
              destinationPort: dst.port,
              host: dst.host,
            },
            rule: 'RabbitDigger'
          }
        }),
      };

      if (typeof callback === 'function') {
        callback({
          data: JSON.stringify(clashData)
        } as any);
      }

      if (!CLOSED.get(this)) {
        setTimeout(poll, 1000);
      }
    };
    poll();
    console.log('addEventListener called', pathname)
    // callback
    return;
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