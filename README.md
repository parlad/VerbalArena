<p align="center">
  <img src="https://img.shields.io/badge/React-18.3-61DAFB?style=for-the-badge&logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Supabase-Realtime-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-3.4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/Vite-5.4-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Netlify-Deployed-00C7B7?style=for-the-badge&logo=netlify&logoColor=white" alt="Netlify" />
</p>

# VerbalArena

**The open platform where ideas compete on merit — not volume.**

VerbalArena is a real-time debate and discussion platform that brings structured, two-sided argumentation to the web. Create debates, post supporting and opposing arguments, vote on the strongest points, and let AI summarize the conversation — all in real time.

---

## Why VerbalArena?

Online discussions are broken. Social media rewards hot takes over thoughtful analysis. Comment sections devolve into noise. VerbalArena fixes this by giving every idea a fair arena: structured sides, evidence-based arguments, community voting, and AI-powered fact-checking.

Whether you're debating policy, technology, science, or culture — VerbalArena keeps the conversation productive.

---

## Features

### Structured Debates
Create debates with custom "supporting" and "opposing" labels. Each side gets its own lane so arguments stay organized and easy to follow. Debates can be opened, closed, or archived by creators and moderators.

### Real-Time Everything
Arguments appear instantly for all participants. Live viewer counts show who's watching. Vote tallies update in real time. Powered by Supabase real-time subscriptions and presence tracking — no refresh needed.

### Community-Curated Topics
Browse and create discussion topics across 12 categories: Politics, AI, Crime & Justice, Nature, Science, Space, Technology, Health, Economics, Education, Sports, and Entertainment. Personalize your feed by selecting preferred categories.

### AI-Powered Insights
- **Debate Summaries** — AI analyzes all supporting and opposing arguments, identifies the dominant position, and generates a balanced summary.
- **Fact-Checking** — Opinions on topics are automatically evaluated for factual accuracy.
- **Position Detection** — AI detects whether an opinion is supporting or opposing, helping maintain structure.

### Evidence & Media Attachments
Back up your arguments with evidence. Attach images, videos, and documents (up to 50MB) directly to debate arguments. Topic opinions support dedicated evidence files for rigorous, source-backed discussions.

### Smart Voting System
Upvote and downvote arguments and topic opinions. Sort by "newest" or "top-voted" to surface the strongest points. Users earn reputation scores and topic creation points as they contribute.

### Common Ground Agreements
A unique feature that identifies shared points between opposing sides — because productive debate isn't just about winning, it's about finding where we agree.

### User Profiles & Reputation
Full user profiles with bios, profile pictures, and reputation scores. Role-based access with user, moderator, and master roles. Account management with active, suspended, and deleted statuses.

### Dark Mode
Full dark mode support, persisted across sessions. Easy toggle from the UI.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 · TypeScript · Tailwind CSS |
| **Build** | Vite 5 |
| **Backend** | Supabase (PostgreSQL + Realtime + Edge Functions) |
| **AI Functions** | Supabase Edge Functions (Deno) |
| **Hosting** | Netlify (SPA with security headers) |
| **Icons** | Lucide React |

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm or yarn
- A [Supabase](https://supabase.com) project

### Installation

```bash
# Clone the repository
git clone https://github.com/parlad/VerbalArena.git
cd VerbalArena

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your Supabase URL and anon key

# Run database migrations
# Apply the SQL files in supabase/migrations/ to your Supabase project

# Start the development server
npm run dev
```

### Environment Variables

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | TypeScript type checking |

---

## Project Structure

```
VerbalArena/
├── src/
│   ├── components/
│   │   ├── AuthModal.tsx          # Login & registration
│   │   ├── CreateDebateModal.tsx   # Debate creation form
│   │   ├── CreateTopicModal.tsx    # Topic creation with categories
│   │   ├── TopicDebateView.tsx     # Main discussion view
│   │   ├── TopicSidebar.tsx        # Category sidebar & navigation
│   │   ├── TopicPreferencesModal.tsx # User category preferences
│   │   └── Toast.tsx               # Notification system
│   ├── lib/
│   │   └── supabase.ts            # Database client & TypeScript types
│   ├── App.tsx                     # Root application component
│   └── main.tsx                    # Entry point
├── supabase/
│   ├── migrations/                 # 17 SQL migration files
│   └── functions/
│       ├── summarize-debate/       # AI debate summarization
│       ├── fact-check-opinion/     # Automated fact-checking
│       └── detect-opinion-position/ # AI position detection
└── netlify.toml                    # Deployment configuration
```

---

## Database Schema

VerbalArena uses a PostgreSQL database with these core tables:

- **users** — Accounts, profiles, reputation scores, and roles
- **debates** — Debate records with status tracking and custom labels
- **arguments** — Two-sided arguments linked to debates
- **argument_media** — File attachments for debate arguments
- **topics** — Community-created discussion topics with categories
- **topic_opinions** — User opinions on topics
- **topic_opinion_votes** — Vote tracking for opinions
- **opinion_evidence** — Evidence files backing topic opinions
- **topic_agreements** — Common ground between opposing sides
- **user_topic_preferences** — Personalized category feeds
- **topic_votes** — Vote tracking for topics

---

## Roadmap

- [ ] Threaded replies on arguments
- [ ] Notification system for debate activity
- [ ] User following and activity feeds
- [ ] Debate templates and categories
- [ ] Mobile app (React Native)
- [ ] Moderation dashboard
- [ ] API for third-party integrations
- [ ] Leaderboards and achievement badges

---

## Contributing

Contributions are welcome! Whether it's a bug fix, new feature, or documentation improvement — open an issue or submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is open source. See the repository for license details.

---

<p align="center">
  Built by <a href="https://github.com/parlad">@parlad</a>
</p>
