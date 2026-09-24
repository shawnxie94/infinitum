export type JsonResult<T> = {
  ok: boolean;
  status: number;
  data: T;
};

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = init ? await fetch(input, init) : await fetch(input);
  return (await response.json()) as T;
}

export async function requestJsonWithMeta<T>(input: RequestInfo | URL, init?: RequestInit): Promise<JsonResult<T>> {
  const response = init ? await fetch(input, init) : await fetch(input);
  return {
    ok: response.ok,
    status: response.status,
    data: (await response.json()) as T,
  };
}

export function getResponseError<T extends { error?: string }>(
  response: Response,
  payload: T,
  fallbackMessage: string,
): string | null {
  if (!response.ok) {
    return payload.error ?? fallbackMessage;
  }
  return payload.error ?? null;
}

export async function fetchJsonOrThrow<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallbackMessage: string,
): Promise<T> {
  const response = init ? await fetch(input, init) : await fetch(input);
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? fallbackMessage);
  }

  return payload;
}
