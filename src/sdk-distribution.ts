/** npm latest is promoted by maintainers only after checking the live host contract. */
export async function sdkPreparation(platformSdk: string | undefined, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher("https://registry.npmjs.org/@zijinhua%2fapp-sdk/latest", { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error("暂时无法获取制作 SDK，请稍后重试");
  const manifest = await response.json() as { name?: unknown; version?: unknown };
  if (manifest.name !== "@zijinhua/app-sdk" || typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new Error("制作 SDK 稳定版本无效");
  if (!platformSdk || !/^\d+\.\d+\.\d+$/.test(platformSdk) || manifest.version.split(".")[0] !== platformSdk.split(".")[0]) throw new Error("制作 SDK 与线上平台大版本不一致，请稍后重试");
  return `本轮开工前必须执行 npm install --save-dev --save-exact @zijinhua/app-sdk@${manifest.version}，更新到最新稳定 SDK；新会话和已有会话的每次修改都必须执行。安装成功后读取 node_modules/@zijinhua/app-sdk/README.md，再开始开发。`;
}
