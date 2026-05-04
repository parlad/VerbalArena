// src/components/TruthCheckPage.tsx
//
// Standalone /truth-check entry point. Lets any signed-in user record audio
// (or audio + video) outside of the topic/opinion flow and walks them through
// the live verification.

import { ArrowLeft, ShieldCheck, Sparkles } from "lucide-react";
import { TruthCheckRecorder } from "./TruthCheckRecorder";

type Props = {
  userId: string;
  username?: string;
  onBack: () => void;
};

export function TruthCheckPage({ userId, onBack }: Props) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 transition-colors">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 mb-6 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <header className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
              Live Truth Check
            </h1>
          </div>
          <p className="text-slate-600 dark:text-slate-400 max-w-2xl">
            Record yourself or upload audio. Each factual claim is transcribed,
            timestamped, and verified against authoritative sources in real time.
            Click any claim to jump to that moment in the recording.
          </p>
          <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Sparkles className="w-3.5 h-3.5" />
            Powered by Gemini 2.5 with Google Search grounding
          </div>
        </header>

        <TruthCheckRecorder userId={userId} />
      </div>
    </div>
  );
}
