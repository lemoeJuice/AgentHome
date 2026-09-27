export const DEFAULT_PROXY_BYPASS = "localhost,127.0.0.1,::1,host.containers.internal,snowluma,agent-home-default";

export function proxyEnvironment(proxyUrl?: string, bypass = process.env.NO_PROXY ?? process.env.no_proxy ?? DEFAULT_PROXY_BYPASS): NodeJS.ProcessEnv {
  if (!proxyUrl) return {};
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: bypass,
    no_proxy: bypass,
    NODE_USE_ENV_PROXY: "1",
  };
}
