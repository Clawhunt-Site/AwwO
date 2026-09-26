FROM node:26.3.0-bookworm-slim AS build
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
ARG VITE_CLAWHUNT_SITE_URL=
ENV VITE_CLAWHUNT_SITE_URL=$VITE_CLAWHUNT_SITE_URL
RUN npm run build:saas
FROM nginx:1.28.0-alpine
COPY deploy/saas/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist-saas/ /usr/share/nginx/html/
EXPOSE 8080
