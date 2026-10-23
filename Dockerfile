# easyBot app for Render (image deploy — keeps GitHub repo private)
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY templates ./templates
ENV NODE_ENV=production
ENV PORT=3080
EXPOSE 3080
CMD ["npm", "start"]
