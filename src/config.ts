function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  mandateSigningKey: requireEnv("MANDATE_SIGNING_KEY"),
  dbPath: process.env.DB_PATH ?? "./data/mandates.db",
  port: Number(process.env.PORT ?? 3000),
};
