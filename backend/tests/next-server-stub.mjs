export class NextRequest {}

export class NextResponse {
  static json(body, init = {}) {
    const status = init.status ?? 200;
    return {
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }
}
