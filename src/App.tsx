import { useEffect, useState } from 'react';
import { MessageSquare, Send, Plus, LogOut, User as UserIcon, Settings, TrendingUp, Sparkles, ThumbsUp } from 'lucide-react';
import { supabase, type Debate, type ArgumentWithUser } from './lib/supabase';
import { AuthModal } from './components/AuthModal';
import { CreateDebateModal } from './components/CreateDebateModal';
import { TopicPreferencesModal } from './components/TopicPreferencesModal';
import { TopicSidebar } from './components/TopicSidebar';
import { CreateTopicModal } from './components/CreateTopicModal';
import { TopicDebateView } from './components/TopicDebateView';

type Topic = {
  topic_id: string;
  title: string;
  description: string;
  category: string;
  source: string;
  external_url?: string;
  vote_count: number;
  creator_user_id?: string;
  created_at: string;
};

type LocalUser = {
  user_id: string;
  username: string;
  email: string;
  reputation_score: number;
  profile_picture_url?: string;
  topic_creation_points?: number;
  role?: 'user' | 'moderator' | 'master';
};

function App() {
  const [currentUser, setCurrentUser] = useState<LocalUser | null>(null);
  const [debate, setDebate] = useState<Debate | null>(null);
  const [debateArguments, setDebateArguments] = useState<ArgumentWithUser[]>([]);
  const [newArgument, setNewArgument] = useState('');
  const [selectedPosition, setSelectedPosition] = useState<'supporting' | 'opposing'>('supporting');
  const [loading, setLoading] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showCreateDebate, setShowCreateDebate] = useState(false);
  const [showTopicPreferences, setShowTopicPreferences] = useState(false);
  const [showCreateTopic, setShowCreateTopic] = useState(false);
  const [userPreferences, setUserPreferences] = useState<string[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const storedUser = localStorage.getItem('verbalarena_user');
    if (storedUser) {
      const user = JSON.parse(storedUser);
      setCurrentUser(user);
      loadUserPreferences(user.user_id);
    }

    loadDebate();
    subscribeToArguments();
  }, []);

  useEffect(() => {
    if (debate) {
      loadArguments();
    }
  }, [debate]);

  async function loadDebate() {
    const { data, error } = await supabase
      .from('debates')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error loading debate:', error);
    } else {
      setDebate(data);
    }
    setLoading(false);
  }

  async function loadArguments() {
    if (!debate?.debate_id) return;

    const { data, error } = await supabase
      .from('arguments')
      .select(`
        *,
        users:user_id (
          username,
          profile_picture_url,
          reputation_score
        )
      `)
      .eq('debate_id', debate.debate_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading arguments:', error);
    } else {
      setDebateArguments(data || []);
    }
  }

  async function loadUserPreferences(userId: string) {
    const { data } = await supabase
      .from('user_topic_preferences')
      .select('category')
      .eq('user_id', userId);

    if (data) {
      setUserPreferences(data.map(p => p.category));
    }
  }

  function subscribeToArguments() {
    const channel = supabase
      .channel('arguments')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'arguments' },
        async (payload) => {
          const { data: userData } = await supabase
            .from('users')
            .select('username, profile_picture_url, reputation_score')
            .eq('user_id', (payload.new as any).user_id)
            .single();

          if (userData) {
            setDebateArguments((current) => [
              ...current,
              { ...payload.new as any, users: userData }
            ]);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }

  async function handleSubmitArgument(e: React.FormEvent) {
    e.preventDefault();

    if (!newArgument.trim() || !debate?.debate_id || !currentUser) {
      if (!currentUser) {
        setShowAuthModal(true);
      }
      return;
    }

    const { error } = await supabase
      .from('arguments')
      .insert({
        debate_id: debate.debate_id,
        user_id: currentUser.user_id,
        content: newArgument.trim(),
        position: selectedPosition,
        upvotes: 0,
        downvotes: 0,
        is_edited: false
      });

    if (error) {
      console.error('Error posting argument:', error);
    } else {
      setNewArgument('');
    }
  }

  function handleLogout() {
    localStorage.removeItem('verbalarena_user');
    setCurrentUser(null);
  }

  function handleAuthSuccess() {
    const storedUser = localStorage.getItem('verbalarena_user');
    if (storedUser) {
      const user = JSON.parse(storedUser);
      setCurrentUser(user);
      loadUserPreferences(user.user_id);
    }
    setShowAuthModal(false);
  }

  function handleDebateCreated() {
    setShowCreateDebate(false);
    loadDebate();
  }

  function handlePreferencesUpdated() {
    setShowTopicPreferences(false);
    if (currentUser) {
      loadUserPreferences(currentUser.user_id);
    }
  }

  function handleTopicCreated() {
    setShowCreateTopic(false);
  }

  function handleTopicSelect(topic: Topic) {
    setSelectedTopic(topic);
  }

  function handleCloseTopic() {
    setSelectedTopic(null);
  }

  const supportingArguments = debateArguments.filter(a => a.position === 'supporting');
  const opposingArguments = debateArguments.filter(a => a.position === 'opposing');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 border-4 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
          <div className="text-lg font-medium text-slate-600">Loading VerbalArena...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Animated Background Elements */}
      <div className="fixed inset-0 -z-10">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-300/30 rounded-full blur-3xl animate-pulse-subtle"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-orange-300/30 rounded-full blur-3xl animate-pulse-subtle" style={{ animationDelay: '1s' }}></div>
      </div>

      <div className="py-8">
        {/* Modern Header */}
        <header className="glass-effect smooth-shadow mb-6 px-6 py-4 animate-slide-down">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-br from-blue-500 to-orange-500 rounded-xl blur opacity-50"></div>
                <div className="relative bg-gradient-to-br from-blue-600 to-orange-500 p-3 rounded-xl shadow-lg">
                  <MessageSquare className="w-6 h-6 text-white" />
                </div>
              </div>
              <div>
                <h1 className="text-3xl font-bold text-slate-900">
                  VerbalArena
                </h1>
                <p className="text-sm text-slate-600 font-medium">Where Ideas Collide</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {currentUser ? (
                <>
                  <div className={`relative ${
                    currentUser.role === 'master'
                      ? 'bg-gradient-to-r from-amber-400 via-orange-500 to-amber-500'
                      : 'glass-effect'
                  } smooth-shadow px-4 py-2 rounded-xl transition-all`}>
                    <div className="flex items-center gap-2.5">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm ${
                        currentUser.role === 'master'
                          ? 'bg-white/20 text-white'
                          : 'bg-gradient-to-br from-slate-600 to-slate-700 text-white'
                      }`}>
                        {currentUser.username[0].toUpperCase()}
                      </div>
                      <div>
                        <div className={`font-bold text-sm flex items-center gap-1.5 ${
                          currentUser.role === 'master' ? 'text-white' : 'text-slate-900'
                        }`}>
                          {currentUser.username}
                          {currentUser.role === 'master' && (
                            <Sparkles className="w-3.5 h-3.5" />
                          )}
                        </div>
                        <div className={`text-xs font-medium ${
                          currentUser.role === 'master' ? 'text-white/90' : 'text-slate-600'
                        }`}>
                          {currentUser.reputation_score} debate · {currentUser.topic_creation_points || 0} topic pts
                        </div>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowTopicPreferences(true)}
                    className="glass-effect smooth-shadow px-4 py-2.5 rounded-xl font-bold text-slate-800 hover:bg-white transition-all flex items-center gap-2"
                    title="Topic Preferences"
                  >
                    <Settings className="w-4 h-4" />
                    <span className="text-sm">Topics</span>
                  </button>
                  <button
                    onClick={() => setShowCreateDebate(true)}
                    className="bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white px-5 py-2.5 rounded-xl font-bold smooth-shadow-lg hover:scale-105 transition-all flex items-center gap-2"
                  >
                    <Plus className="w-5 h-5" />
                    <span className="text-sm">New Debate</span>
                  </button>
                  <button
                    onClick={handleLogout}
                    className="glass-effect smooth-shadow p-2.5 rounded-xl font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-600 hover:scale-105 transition-all"
                    title="Logout"
                  >
                    <LogOut className="w-5 h-5" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowAuthModal(true)}
                  className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-8 py-3 rounded-xl font-bold smooth-shadow-lg hover:scale-105 transition-all text-sm"
                >
                  Sign In / Sign Up
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="flex gap-0">
          <div className="flex-1">
            {selectedTopic ? (
              <TopicDebateView
                topic={selectedTopic}
                userId={currentUser?.user_id}
                onClose={handleCloseTopic}
              />
            ) : debate ? (
              <>
                <div className="relative group mb-12 animate-slide-up">
                  <div className="absolute inset-0 bg-gradient-to-br from-orange-500/20 to-blue-500/20 rounded-3xl blur-2xl group-hover:blur-3xl transition-all"></div>
                  <div className="relative glass-effect smooth-shadow-lg rounded-3xl p-10 hover:smooth-shadow-lg hover:-translate-y-1 transition-all border-2 border-orange-200/30">
                    <div className="flex items-start justify-between mb-6">
                      <div className="inline-flex items-center gap-2 bg-gradient-to-r from-orange-500 to-orange-600 px-4 py-2 rounded-full shadow-lg">
                        <TrendingUp className="w-4 h-4 text-white" />
                        <span className="text-sm font-bold text-white">Active Debate</span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-2 bg-white/80 px-3 py-1.5 rounded-full">
                          <MessageSquare className="w-4 h-4 text-emerald-600" />
                          <span className="font-bold text-slate-700">{supportingArguments.length + opposingArguments.length}</span>
                        </div>
                        <div className="flex items-center gap-2 bg-white/80 px-3 py-1.5 rounded-full">
                          <ThumbsUp className="w-4 h-4 text-blue-600" />
                          <span className="font-bold text-slate-700">{debate.upvotes || 0}</span>
                        </div>
                      </div>
                    </div>
                    <h2 className="text-4xl font-bold text-slate-800 mb-4 leading-tight">
                      {debate.title}
                    </h2>
                    <p className="text-lg text-slate-600 leading-relaxed">
                      {debate.description}
                    </p>
                  </div>
                </div>

                <div className="mb-8 animate-slide-up">
                  <div className="space-y-4">
                    {debateArguments.length === 0 ? (
                      <div className="glass-effect smooth-shadow rounded-3xl p-12 text-center">
                        <div className="w-16 h-16 bg-gradient-to-br from-slate-200 to-slate-300 rounded-2xl flex items-center justify-center mx-auto mb-4">
                          <MessageSquare className="w-8 h-8 text-slate-500" />
                        </div>
                        <p className="text-lg font-bold text-slate-700 mb-2">No arguments yet</p>
                        <p className="text-slate-500">Be the first to share your perspective!</p>
                      </div>
                    ) : (
                      debateArguments.map((arg, index) => (
                        <div
                          key={arg.argument_id}
                          className="relative group animate-fade-in"
                          style={{ animationDelay: `${index * 0.05}s` }}
                        >
                          <div className={`absolute inset-0 rounded-3xl blur-xl transition-all ${
                            arg.position === 'supporting'
                              ? 'bg-gradient-to-br from-emerald-400/20 to-green-500/20'
                              : 'bg-gradient-to-br from-rose-400/20 to-red-500/20'
                          }`}></div>
                          <div className="relative glass-effect smooth-shadow hover:smooth-shadow-lg hover:-translate-y-1 rounded-3xl p-6 transition-all">
                            <div className="flex items-start justify-between gap-4 mb-4">
                              <div className="flex items-center gap-3">
                                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold shadow-lg ${
                                  arg.position === 'supporting'
                                    ? 'bg-gradient-to-br from-emerald-500 to-green-600'
                                    : 'bg-gradient-to-br from-rose-500 to-red-600'
                                }`}>
                                  {arg.users.username[0].toUpperCase()}
                                </div>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-slate-800">{arg.users.username}</span>
                                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                                      arg.position === 'supporting'
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : 'bg-rose-100 text-rose-700'
                                    }`}>
                                      {arg.position === 'supporting' ? debate.supporting_label : debate.opposing_label}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-slate-500 font-medium mt-1">
                                    <span>{arg.users.reputation_score} pts</span>
                                    <span>•</span>
                                    <span>{new Date(arg.created_at).toLocaleTimeString()}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                            <p className="text-slate-700 leading-relaxed text-lg">{arg.content}</p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="animate-slide-up" style={{ animationDelay: '0.2s' }}>
                  <div className="relative group">
                    <div className="absolute inset-0 bg-gradient-to-br from-blue-400/20 to-slate-400/20 rounded-3xl blur-xl group-hover:blur-2xl transition-all"></div>
                    <div className="relative glass-effect smooth-shadow-lg rounded-3xl p-8 hover:smooth-shadow-lg transition-all">
                      <h3 className="text-3xl font-bold text-slate-800 mb-8">
                        Share Your Perspective
                      </h3>

                      {!currentUser && (
                        <div className="bg-white rounded-2xl p-6 mb-6 text-center border-2 border-orange-200">
                          <div className="w-16 h-16 bg-gradient-to-br from-orange-500 to-orange-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <UserIcon className="w-8 h-8 text-white" />
                          </div>
                          <p className="text-lg font-bold text-slate-900 mb-2">Join the Discussion</p>
                          <p className="text-slate-600 mb-4">Sign in to share your arguments and perspectives</p>
                          <button
                            onClick={() => setShowAuthModal(true)}
                            className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-8 py-3 rounded-xl font-bold smooth-shadow-lg hover:scale-105 transition-all"
                          >
                            Sign In / Sign Up
                          </button>
                        </div>
                      )}

                      <form onSubmit={handleSubmitArgument} className="space-y-6">
                        <div>
                          <label className="block text-sm font-bold text-slate-700 mb-4">
                            Choose Your Position
                          </label>
                          <div className="grid grid-cols-2 gap-4">
                            <button
                              type="button"
                              onClick={() => setSelectedPosition('supporting')}
                              disabled={!currentUser}
                              className={`relative group py-5 px-6 rounded-2xl font-bold transition-all ${
                                selectedPosition === 'supporting'
                                  ? 'bg-gradient-to-br from-emerald-500 to-green-600 text-white smooth-shadow-lg scale-105'
                                  : 'glass-effect text-slate-700 hover:scale-105'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              {selectedPosition === 'supporting' && (
                                <div className="absolute inset-0 bg-gradient-to-br from-emerald-400 to-green-500 rounded-2xl blur-lg opacity-50"></div>
                              )}
                              <span className="relative">{debate.supporting_label}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedPosition('opposing')}
                              disabled={!currentUser}
                              className={`relative group py-5 px-6 rounded-2xl font-bold transition-all ${
                                selectedPosition === 'opposing'
                                  ? 'bg-gradient-to-br from-rose-500 to-red-600 text-white smooth-shadow-lg scale-105'
                                  : 'glass-effect text-slate-700 hover:scale-105'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              {selectedPosition === 'opposing' && (
                                <div className="absolute inset-0 bg-gradient-to-br from-rose-400 to-red-500 rounded-2xl blur-lg opacity-50"></div>
                              )}
                              <span className="relative">{debate.opposing_label}</span>
                            </button>
                          </div>
                        </div>

                        <div>
                          <label htmlFor="argument" className="block text-sm font-bold text-slate-700 mb-3">
                            Your Argument
                          </label>
                          <textarea
                            id="argument"
                            name="argument"
                            value={newArgument}
                            onChange={(e) => setNewArgument(e.target.value)}
                            placeholder="Share your thoughts, arguments, and perspectives..."
                            rows={6}
                            disabled={!currentUser}
                            className="w-full px-5 py-4 rounded-2xl border-2 border-slate-200 focus:border-blue-400 focus:ring-4 focus:ring-blue-100 outline-none transition-all resize-none disabled:bg-slate-50 disabled:cursor-not-allowed font-medium text-slate-700 placeholder:text-slate-400"
                            required
                          />
                        </div>

                        <button
                          type="submit"
                          disabled={!currentUser}
                          className="relative group w-full bg-gradient-to-r from-slate-800 to-slate-900 hover:from-slate-900 hover:to-black text-white font-bold py-5 px-6 rounded-2xl transition-all flex items-center justify-center gap-3 smooth-shadow-lg hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
                        >
                          <div className="absolute inset-0 bg-gradient-to-r from-blue-600/20 to-emerald-600/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                          <Send className="w-5 h-5 relative z-10" />
                          <span className="relative z-10">Post Your Argument</span>
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="relative group animate-fade-in">
                <div className="absolute inset-0 bg-gradient-to-br from-orange-500/20 to-blue-500/20 rounded-3xl blur-2xl animate-pulse-subtle"></div>
                <div className="relative glass-effect smooth-shadow-lg rounded-3xl p-16 text-center border-2 border-orange-200/50">
                  <div className="relative w-24 h-24 mx-auto mb-8">
                    <div className="absolute inset-0 bg-gradient-to-br from-orange-400 to-orange-600 rounded-2xl blur-xl opacity-50 animate-pulse"></div>
                    <div className="relative w-24 h-24 bg-gradient-to-br from-orange-500 to-orange-600 rounded-2xl flex items-center justify-center shadow-2xl">
                      <MessageSquare className="w-12 h-12 text-white" />
                    </div>
                  </div>
                  <h3 className="text-3xl font-bold text-slate-900 mb-4">No debates yet — be the first to start the conversation!</h3>
                  <p className="text-lg text-slate-700 mb-8 max-w-md mx-auto leading-relaxed">
                    Share your perspective and ignite meaningful discussions on topics that matter.
                  </p>
                  {currentUser ? (
                    <button
                      onClick={() => setShowCreateDebate(true)}
                      className="relative group/btn bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white px-10 py-5 rounded-2xl font-bold smooth-shadow-lg hover:scale-110 transition-all inline-flex items-center gap-3 text-lg overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 -translate-x-full group-hover/btn:translate-x-full transition-transform duration-700"></div>
                      <Plus className="w-6 h-6 relative z-10" />
                      <span className="relative z-10">Create New Debate</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowAuthModal(true)}
                      className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-10 py-5 rounded-2xl font-bold smooth-shadow-lg hover:scale-110 transition-all text-lg"
                    >
                      Sign In to Create Debate
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className={`flex-shrink-0 transition-all duration-300 ${sidebarCollapsed ? 'w-20' : 'w-80'}`}>
            <TopicSidebar
              userId={currentUser?.user_id}
              userPreferences={userPreferences}
              onCreateTopic={() => setShowCreateTopic(true)}
              onTopicSelect={handleTopicSelect}
              selectedTopicId={selectedTopic?.topic_id}
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
          </div>
        </div>
      </div>

      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onSuccess={handleAuthSuccess}
        />
      )}

      {showCreateDebate && currentUser && (
        <CreateDebateModal
          userId={currentUser.user_id}
          onClose={() => setShowCreateDebate(false)}
          onSuccess={handleDebateCreated}
        />
      )}

      {showTopicPreferences && currentUser && (
        <TopicPreferencesModal
          userId={currentUser.user_id}
          onClose={() => setShowTopicPreferences(false)}
          onSuccess={handlePreferencesUpdated}
        />
      )}

      {showCreateTopic && currentUser && (
        <CreateTopicModal
          userId={currentUser.user_id}
          onClose={() => setShowCreateTopic(false)}
          onSuccess={handleTopicCreated}
        />
      )}
    </div>
  );
}

export default App;
