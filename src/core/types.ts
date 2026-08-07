export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type Sha256 = Brand<string, 'Sha256'>;

export type IsoDateTime = Brand<string, 'IsoDateTime'>;
