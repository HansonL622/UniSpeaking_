# UniSpeaking

UniSpeaking is organized as a monorepo containing the backend, Web frontend,
and mobile frontend.

```text
backend/unispeaking-server  Spring Boot business and realtime control plane
frontend/web                React and Vite Web client
frontend/mobile             React Native and Expo mobile client
deploy                      Compose and nginx configuration
docs                        Architecture and business-flow documentation
```

The Web and mobile clients currently contain high-fidelity interactive
prototypes. Unless a feature explicitly uses `realtimeClient`, its data and
scoring behavior should be treated as local demo data rather than a completed
backend integration.

## Run locally

Backend:

```bash
cp deploy/env/.env.example deploy/env/.env
# Fill REALTIME_QWEN_API_KEY in deploy/env/.env
cd backend/unispeaking-server
./mvnw spring-boot:run
```

Web frontend:

```bash
cd frontend/web
npm install
npm run dev
```

Mobile frontend Web preview:

```bash
cd frontend/mobile
npm install
npm run web
```

Mobile Android development uses the Expo development client and a physical
device. See `frontend/mobile/README.md` and `frontend/mobile/HANDOFF.md` for the
current workflow and product boundaries.

## Documentation

- Backend architecture: `docs/architecture.md`
- Realtime sequence: `docs/realtime-sequence.md`
- Deployment: `docs/deployment.md`
- Frontend overview: `frontend/README.md`
