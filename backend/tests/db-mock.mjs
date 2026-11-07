export async function query(text, values = []) {
  if (typeof globalThis.__securityQuery !== "function") {
    throw new Error("security query mock is not installed");
  }
  return globalThis.__securityQuery(text, values);
}

export const pool = {
  async connect() {
    return {
      query,
      release() {},
    };
  },
};

export function isMissingSchemaError() {
  return false;
}
