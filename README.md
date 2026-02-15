# CyclAwps Node

Intelligence node built on the [CyclAwps](https://github.com/controlborgs/cyclawps) core engine. Extends the core with autonomous AI agents and shared intelligence.

## Quick Start

```bash
npm install
docker compose up -d postgres redis
cp .env.example .env
npx prisma migrate dev
npm run dev
```
