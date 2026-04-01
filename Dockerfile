# brm-service/Dockerfile
FROM node:20

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy prisma schema first (important)
COPY prisma ./prisma

# Generate Prisma client
RUN npx prisma generate

# Copy remaining source code
COPY . .

ENV NODE_ENV=production

EXPOSE 2812

CMD ["npm", "start"]