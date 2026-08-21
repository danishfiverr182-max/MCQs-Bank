import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

// Generic virtualized list wrapper — takes no domain-specific knowledge,
// just `items` + a `renderRow(item, index)` function, so it's reusable for
// the MCQ list today and the Activity Log or any other large list later
// without modification.
//
// Only visible rows (plus `overscan` extra rows above/below the viewport)
// are actually mounted in the DOM at any time, regardless of how many
// `items` are in memory — this is what keeps scrolling smooth at
// hundreds/thousands of rows.
export default function VirtualList({
  items,
  estimateRowHeight = 56,
  renderRow,
  overscan = 8,
  containerHeight = 600,
}) {
  const parentRef = useRef(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan,
  });

  // items.length === 0 still renders a (harmless, empty) scroll container —
  // the parent page is responsible for showing EmptyState instead of even
  // mounting VirtualList when there's nothing to show.
  return (
    <div ref={parentRef} style={{ height: containerHeight, overflow: 'auto' }}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderRow(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
