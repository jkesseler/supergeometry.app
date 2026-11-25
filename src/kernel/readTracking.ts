export const rawGet = <V>(map: Map<string, V>, key: string): V | undefined => Map.prototype.get.call(map, key) as V | undefined;
export const rawHas = (map: Map<string, unknown>, key: string): boolean => Map.prototype.has.call(map, key) as boolean;
export const rawEntries = <V>(map: Map<string, V>): [string, V][] => [...(Map.prototype.entries.call(map) as IterableIterator<[string, V]>)];
