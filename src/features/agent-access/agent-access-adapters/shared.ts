export function credentialsSnippet(token: string, type: "api" | "api_key") {
  return JSON.stringify({ flowlet: { type, key: token } }, null, 2);
}
