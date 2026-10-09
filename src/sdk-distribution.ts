/** npm latest is promoted only after publishing the matching host implementation. */
export async function sdkPreparation(hostSdk: string | undefined, fetcher: typeof fetch = fetch): Promise<string> {
  if (!hostSdk || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(hostSdk)) throw new Error("线上宿主 SDK 版本无效，请稍后重试");
  const response = await fetcher("https://registry.npmjs.org/@zijinhua%2fapp-sdk/latest", { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error("暂时无法获取制作 SDK，请稍后重试");
  const manifest = await response.json() as { name?: unknown; version?: unknown };
  if (manifest.name !== "@zijinhua/app-sdk" || typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new Error("制作 SDK 稳定版本无效");
  const sdk = manifest.version.split(".").map(Number), host = hostSdk.split(".").map(Number);
  if (sdk[0] !== host[0]) throw new Error("制作 SDK 与线上宿主大版本不一致，请稍后重试");
  if (sdk[1] > host[1] || (sdk[1] === host[1] && sdk[2] > host[2])) throw new Error("最新 SDK 的配套宿主尚未发布，请稍后重试");
  return `先执行 npm install --save-dev --save-exact @zijinhua/app-sdk@${manifest.version}，再阅读 node_modules/@zijinhua/app-sdk/README.md。`;
}
