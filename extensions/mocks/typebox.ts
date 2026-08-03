// Mock implementation of @sinclair/typebox for testing

export const Type = {
	Object: (schema: any, options?: any) => ({ type: "object", ...schema, ...options }),
	String: (options?: any) => ({ type: "string", ...options }),
	Number: (options?: any) => ({ type: "number", ...options }),
	Boolean: (options?: any) => ({ type: "boolean", ...options }),
	Array: (items: any, options?: any) => ({ type: "array", items, ...options }),
	Optional: (schema: any) => ({ type: "optional", schema }),
	Literal: (value: any) => ({ type: "literal", const: value }),
	Union: (items: any[], options?: any) => ({ type: "union", anyOf: items, ...options }),
	Enum: (enumObj: any) => ({ type: "enum", enum: Object.values(enumObj) }),
	Unknown: (options?: any) => ({ type: "unknown", ...options }),
};
