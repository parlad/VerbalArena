import { useState } from 'react';
import { X, MessageSquare } from 'lucide-react';
import { supabase } from '../lib/supabase';

type CreateDebateModalProps = {
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
};

export function CreateDebateModal({ userId, onClose, onSuccess }: CreateDebateModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [supportingLabel, setSupportingLabel] = useState('Supporting');
  const [opposingLabel, setOpposingLabel] = useState('Opposing');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error: insertError } = await supabase
        .from('debates')
        .insert({
          creator_user_id: userId,
          title: title.trim(),
          description: description.trim(),
          supporting_label: supportingLabel.trim(),
          opposing_label: opposingLabel.trim(),
          status: 'open',
          view_count: 0
        });

      if (insertError) {
        setError('Failed to create debate');
        setLoading(false);
        return;
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

        <div className="flex items-center gap-3 mb-6">
          <MessageSquare className="w-8 h-8 text-slate-700" />
          <h2 className="text-3xl font-bold text-slate-900">Create New Debate</h2>
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="debate-title" className="block text-sm font-medium text-slate-700 mb-2">
              Debate Title
            </label>
            <input
              id="debate-title"
              name="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Should artificial intelligence be regulated by governments?"
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
              required
              maxLength={255}
            />
          </div>

          <div>
            <label htmlFor="debate-description" className="block text-sm font-medium text-slate-700 mb-2">
              Description
            </label>
            <textarea
              id="debate-description"
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide context and background for this debate..."
              rows={4}
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all resize-none"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="supporting-label" className="block text-sm font-medium text-slate-700 mb-2">
                Supporting Side Label
              </label>
              <input
                id="supporting-label"
                name="supportingLabel"
                type="text"
                value={supportingLabel}
                onChange={(e) => setSupportingLabel(e.target.value)}
                placeholder="Supporting"
                className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
                required
                maxLength={50}
              />
            </div>

            <div>
              <label htmlFor="opposing-label" className="block text-sm font-medium text-slate-700 mb-2">
                Opposing Side Label
              </label>
              <input
                id="opposing-label"
                name="opposingLabel"
                type="text"
                value={opposingLabel}
                onChange={(e) => setOpposingLabel(e.target.value)}
                placeholder="Opposing"
                className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
                required
                maxLength={50}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-6 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating...' : 'Create Debate'}
          </button>
        </form>
      </div>
    </div>
  );
}
