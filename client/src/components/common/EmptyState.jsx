import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Consistent, polished empty-state used across list/table pages, replacing
// the scattered inline "No data" text each page previously hand-rolled.
// `actionLabel`/`onAction` are optional — not every empty state needs a CTA
// (e.g. a read-only activity log has nothing to "add").
export default function EmptyState({
  icon: Icon = Inbox,
  title = 'Nothing here yet',
  message,
  actionLabel,
  onAction,
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="h-12 w-12 rounded-full bg-primary-50 flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-primary-600" strokeWidth={1.75} />
      </div>
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {message && (
        <p className="mt-1 text-sm text-gray-500 max-w-sm">{message}</p>
      )}
      {actionLabel && onAction && (
        <Button className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
