export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
  readonly meta?: { readonly total: number; readonly page: number; readonly limit: number };
}

export * from "./ecies";
