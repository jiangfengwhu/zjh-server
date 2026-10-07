/** npm latest is promoted by maintainers only after checking the live host contract. */
export async function sdkPreparation(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher("https://registry.npmjs.org/@zijinhua%2fapp-sdk/latest", { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error("暂时无法获取制作 SDK，请稍后重试");
  const manifest = await response.json() as { name?: unknown; version?: unknown };
  if (manifest.name !== "@zijinhua/app-sdk" || typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new Error("制作 SDK 稳定版本无效");
  return `先执行 npm install --save-dev --save-exact @zijinhua/app-sdk@${manifest.version}。`;
}
