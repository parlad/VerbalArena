import { useEffect } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

export type ToastItem = {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
};

type ToastContainerProps = {
  toasts: ToastItem[];
  onRemove: (id: string) => void;
};

type SingleToastProps = {
  toast: ToastItem;
  onRemove: (id: string) => void;
};

function SingleToast({ toast, onRemove }: SingleToastProps) {
  useEffect(() => {
    const timer = setTimeout(() => onRemove(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onRemove]);

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-emerald-500 flex-shrink-0" />,
    error: <XCircle className="w-5 h-5 text-rose-500 flex-shrink-0" />,
    info: <Info className="w-5 h-5 text-blue-500 flex-shrink-0" />,
  };

  const borders = {
    success: 'border-emerald-200 dark:border-emerald-700',
    error: 'border-rose-200 dark:border-rose-700',
    info: 'border-blue-200 dark:border-blue-700',
  };

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border-2 bg-white dark:bg-slate-800 ${borders[toast.type]} animate-slide-up min-w-[280px] max-w-sm`}
      style={{ animation: 'slideUp 0.3s ease-out' }}
    >
      {icons[toast.type]}
      <p className="flex-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{toast.message}</p>
      <button
        onClick={() => onRemove(toast.id)}
        className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function Toast({ toasts, onRemove }: ToastContainerProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-3 pointer-events-none">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <SingleToast toast={toast} onRemove={onRemove} />
        </div>
      ))}
    </div>
  );
}
