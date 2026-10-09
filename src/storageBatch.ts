/** Durable Object multi-get accepts at most 128 keys. */
export async function getMany<T>(storage: Pick<DurableObjectStorage, "get">, keys: string[]): Promise<Map<string,T>> {
  const unique = [...new Set(keys)], result = new Map<string,T>();
  for (let offset=0; offset<unique.length; offset+=128) for (const [key,value] of await storage.get<T>(unique.slice(offset,offset+128))) result.set(key,value);
  return result;
}
