import { useState } from 'react';
import { X, User, Mail, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';

type AuthModalProps = {
  onClose: () => void;
  onSuccess: () => void;
};

export function AuthModal({ onClose, onSuccess }: AuthModalProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isLogin) {
        const { data: user, error: dbError } = await supabase
          .from('users')
          .select('*')
          .eq('username', username)
          .maybeSingle();

        if (dbError || !user || user.password_hash !== password) {
          setError('Invalid username or password');
          setLoading(false);
          return;
        }

        if (user.account_status !== 'active') {
          setError('Account is suspended or deleted');
          setLoading(false);
          return;
        }

        localStorage.setItem('verbalarena_user', JSON.stringify({
          user_id: user.user_id,
          username: user.username,
          email: user.email,
          reputation_score: user.reputation_score,
          profile_picture_url: user.profile_picture_url,
          role: user.role,
          topic_creation_points: user.topic_creation_points
        }));

        onSuccess();
      } else {
        const { data: existingUser } = await supabase
          .from('users')
          .select('username, email')
          .or(`username.eq.${username},email.eq.${email}`)
          .maybeSingle();

        if (existingUser) {
          if (existingUser.username === username) {
            setError('Username already taken');
          } else {
            setError('Email already registered');
          }
          setLoading(false);
          return;
        }

        const { data: newUser, error: insertError } = await supabase
          .from('users')
          .insert({
            username,
            email,
            password_hash: password,
            reputation_score: 0,
            account_status: 'active'
          })
          .select()
          .single();

        if (insertError) {
          setError('Failed to create account');
          setLoading(false);
          return;
        }

        localStorage.setItem('verbalarena_user', JSON.stringify({
          user_id: newUser.user_id,
          username: newUser.username,
          email: newUser.email,
          reputation_score: newUser.reputation_score,
          profile_picture_url: newUser.profile_picture_url,
          role: newUser.role,
          topic_creation_points: newUser.topic_creation_points
        }));

        onSuccess();
      }
    } catch {
      setError('An error occurred. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="w-6 h-6" />
        </button>

        <h2 className="text-3xl font-bold text-slate-900 mb-6">
          {isLogin ? 'Welcome Back' : 'Join VerbalArena'}
        </h2>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-2">
              <User className="w-4 h-4 inline mr-2" />
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
              required
              minLength={3}
              maxLength={50}
            />
          </div>

          {!isLogin && (
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-2">
                <Mail className="w-4 h-4 inline mr-2" />
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-2">
              <Lock className="w-4 h-4 inline mr-2" />
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all"
              required
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-6 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => {
              setIsLogin(!isLogin);
              setError('');
            }}
            className="text-slate-600 hover:text-slate-900 transition-colors"
          >
            {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
