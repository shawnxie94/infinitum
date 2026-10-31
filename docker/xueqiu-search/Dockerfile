FROM diygod/rsshub@sha256:8d7c504a9ad29193e83db1c667f844ecc05940ddaca512c38221b77fb7e1cba2
USER root
RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends chromium && apt-get clean
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
COPY scripts/xueqiu/server.mjs /app/xueqiu-search.mjs
EXPOSE 3100
CMD ["node", "/app/xueqiu-search.mjs"]
