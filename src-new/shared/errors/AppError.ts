export type AppError = {
  code: string;
  message: string;
  detail?: string;
  retryable: boolean;
};