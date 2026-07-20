FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Ferramentas do backup offsite (scripts/pg_dump_offsite.sh, cron 03:00).
# Sem elas o cron falhava silenciosamente todo dia: a imagem slim não traz
# pg_dump nem aws. postgresql-client vem do repositório PGDG porque o do
# Debian bookworm é o 15 — pg_dump precisa ser >= a versão do servidor
# Supabase, senão o dump aborta com "server version mismatch".
# awscli (v1, do Debian) cobre `aws s3 cp` e R2 via --endpoint-url.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 awscli \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001
CMD ["npm", "start"]
