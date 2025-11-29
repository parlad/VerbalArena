import { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';

type TopicPreferencesModalProps = {
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
};

const CATEGORIES = [
  { id: 'politics', label: 'Politics', emoji: '🏛️' },
  { id: 'ai', label: 'Artificial Intelligence', emoji: '🤖' },
  { id: 'crime', label: 'Crime & Justice', emoji: '⚖️' },
  { id: 'nature', label: 'Nature & Environment', emoji: '🌿' },
  { id: 'science', label: 'Science', emoji: '🔬' },
  { id: 'space', label: 'Space & Astronomy', emoji: '🚀' },
  { id: 'technology', label: 'Technology', emoji: '💻' },
  { id: 'health', label: 'Health & Medicine', emoji: '⚕️' },
  { id: 'economics', label: 'Economics & Finance', emoji: '💰' },
  { id: 'education', label: 'Education', emoji: '📚' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'entertainment', label: 'Entertainment', emoji: '🎬' }
];

export function TopicPreferencesModal({ userId, onClose, onSuccess }: TopicPreferencesModalProps) {
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    loadPreferences();
  }, [userId]);

  async function loadPreferences() {
    const { data } = await supabase
      .from('user_topic_preferences')
      .select('category')
      .eq('user_id', userId);

    if (data) {
      setSelectedCategories(new Set(data.map(p => p.category)));
    }
    setInitialLoading(false);
  }

  function toggleCategory(categoryId: string) {
    const newSelected = new Set(selectedCategories);
    if (newSelected.has(categoryId)) {
      newSelected.delete(categoryId);
    } else {
      newSelected.add(categoryId);
    }
    setSelectedCategories(newSelected);
  }

  async function handleSave() {
    setLoading(true);

    await supabase
      .from('user_topic_preferences')
      .delete()
      .eq('user_id', userId);

    if (selectedCategories.size > 0) {
      const preferences = Array.from(selectedCategories).map(category => ({
        user_id: userId,
        category
      }));

      await supabase
        .from('user_topic_preferences')
        .insert(preferences);
    }

    setLoading(false);
    onSuccess();
  }

  if (initialLoading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-8">
          <div className="text-center text-slate-600">Loading...</div>
        </div>
      </div>
    );
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

        <h2 className="text-3xl font-bold text-slate-900 mb-2">Choose Your Topics</h2>
        <p className="text-slate-600 mb-6">
          Select the topics you're interested in discussing. We'll show you relevant debates and trending topics.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              onClick={() => toggleCategory(category.id)}
              className={`p-4 rounded-xl border-2 transition-all text-left ${
                selectedCategories.has(category.id)
                  ? 'border-slate-900 bg-slate-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-2xl">{category.emoji}</span>
                {selectedCategories.has(category.id) && (
                  <Check className="w-5 h-5 text-slate-900" />
                )}
              </div>
              <div className="font-medium text-slate-900 text-sm">{category.label}</div>
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={loading || selectedCategories.size === 0}
            className="flex-1 bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-6 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Saving...' : `Save Preferences${selectedCategories.size > 0 ? ` (${selectedCategories.size})` : ''}`}
          </button>
          <button
            onClick={onClose}
            className="px-6 py-3 border-2 border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-50 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
