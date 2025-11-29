import { useState } from 'react';
import { X, Sparkles, Award } from 'lucide-react';
import { supabase } from '../lib/supabase';

type CreateTopicModalProps = {
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
};

const CATEGORIES = [
  { id: 'politics', label: 'Politics' },
  { id: 'ai', label: 'Artificial Intelligence' },
  { id: 'crime', label: 'Crime & Justice' },
  { id: 'nature', label: 'Nature & Environment' },
  { id: 'science', label: 'Science' },
  { id: 'space', label: 'Space & Astronomy' },
  { id: 'technology', label: 'Technology' },
  { id: 'health', label: 'Health & Medicine' },
  { id: 'economics', label: 'Economics & Finance' },
  { id: 'education', label: 'Education' },
  { id: 'sports', label: 'Sports' },
  { id: 'entertainment', label: 'Entertainment' }
];

const POINTS_REWARD = 10;

export function CreateTopicModal({ userId, onClose, onSuccess }: CreateTopicModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error: insertError } = await supabase
        .from('topics')
        .insert({
          creator_user_id: userId,
          title: title.trim(),
          description: description.trim(),
          category,
          source: 'user_created',
          external_url: externalUrl.trim() || null,
          status: 'approved',
          vote_count: 0
        });

      if (insertError) {
        setError('Failed to create topic');
        setLoading(false);
        return;
      }

      const { error: updateError } = await supabase
        .from('users')
        .update({
          topic_creation_points: supabase.sql`topic_creation_points + ${POINTS_REWARD}`
        })
        .eq('user_id', userId);

      if (updateError) {
        console.error('Failed to award points:', updateError);
      }

      onSuccess();
    } catch (err) {
      setError('An error occurred');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-8 relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="w-6 h-6" />
        </button>

        <div className="flex items-center gap-3 mb-2">
          <Sparkles className="w-8 h-8 text-slate-700" />
          <h2 className="text-3xl font-bold text-slate-900">Create New Topic</h2>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-6 flex items-center gap-2">
          <Award className="w-5 h-5 text-amber-600" />
          <span className="text-sm text-amber-800">
            Earn <strong>{POINTS_REWARD} points</strong> for creating a topic!
          </span>
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="topic-title" className="block text-sm font-medium text-slate-700 mb-2">
              Topic Title *
            </label>
            <input
              id="topic-title"
              name="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Should AI be allowed to make medical diagnoses?"
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
              required
              maxLength={255}
            />
          </div>

          <div>
            <label htmlFor="topic-description" className="block text-sm font-medium text-slate-700 mb-2">
              Description
            </label>
            <textarea
              id="topic-description"
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide more context about this topic..."
              rows={3}
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all resize-none"
            />
          </div>

          <div>
            <label htmlFor="topic-category" className="block text-sm font-medium text-slate-700 mb-2">
              Category *
            </label>
            <select
              id="topic-category"
              name="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
              required
            >
              <option value="">Select a category</option>
              {CATEGORIES.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="external-url" className="block text-sm font-medium text-slate-700 mb-2">
              External Link (optional)
            </label>
            <input
              id="external-url"
              name="externalUrl"
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="https://example.com/article"
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-6 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating...' : `Create Topic & Earn ${POINTS_REWARD} Points`}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-3 border-2 border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-50 transition-all"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
