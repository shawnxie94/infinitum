FROM ghcr.io/rachelos/base-full@sha256:e5f4ad4dd43f0bd86fc5614da683aa78e5b877c21cf42a6c20a2554c0df7cede
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple INSTALL=True BROWSER_TYPE=webkit PLANT_PATH=/app/env WEREAD_LIC_PATH=/app/data/wx.lic WEREAD_PROFILE_DIR=/app/data/weread-chrome-profile PLAYWRIGHT_BROWSERS_PATH=/app/env/driver/_x86_64
WORKDIR /app
ADD https://codeload.github.com/rachelos/we-mp-rss/tar.gz/9fd4edb2a9311bffa571db050f53f415705db294 /tmp/werss-source.tar.gz
RUN echo '74399475013d5bc0e9776b0ae4bc97edc6f09b301de15e7453c64423b76f53b9  /tmp/werss-source.tar.gz' | sha256sum -c - && tar -xzf /tmp/werss-source.tar.gz -C /app --strip-components=1
COPY scripts/werss/sanitize-upstream.py /tmp/sanitize-upstream.py
RUN python3 /tmp/sanitize-upstream.py && chmod +x /app/install.sh /app/start.sh && /app/install.sh && cp /app/config.example.yaml /app/config.yaml
EXPOSE 8001
CMD ["/app/start.sh"]
