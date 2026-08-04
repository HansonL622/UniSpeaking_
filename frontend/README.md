# UniSpeaking Frontends

The Web and mobile applications are separate projects that share product
language and interaction rules but do not share source code.

```text
frontend/
├── web/     React 19 + Vite Web application
└── mobile/  React Native + Expo Router mobile application
```

## Web

The Web application is the approved desktop interaction and visual reference.
It includes free conversation, scenario training, IELTS, English interview,
learning assets, profile, and membership prototype flows.

```bash
cd frontend/web
npm install
npm run dev
npm run build
```

## Mobile

The mobile application adapts the approved Web information architecture for a
phone-sized interface. It uses React Native, TypeScript, Expo SDK 57, and Expo
Router. Mobile navigation and layouts are implemented independently rather than
scaling down the desktop page.

```bash
cd frontend/mobile
npm install
npx tsc --noEmit
npm run web
```

The mobile IELTS, English interview, scoring, recording, and conversation data
are currently frontend prototypes unless otherwise documented. Read
`mobile/HANDOFF.md` before connecting backend services.
