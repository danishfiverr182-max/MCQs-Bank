import { useRef, useState } from 'react';

const formatFileSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const STATE_STYLES = {
  idle: 'border-surface-border bg-white hover:border-primary-300 hover:bg-primary-50/30',
  dragging: 'border-primary-500 bg-primary-50',
  fileSelected: 'border-easy bg-easy-light/40',
  error: 'border-danger bg-red-50',
};

/**
 * Drag-and-drop (+ click-to-browse) intake zone for a single file.
 *
 * Runs the same checks the backend enforces (Prompt 41) client-side
 * first, so the user gets instant feedback instead of waiting on a
 * round trip just to learn their file was the wrong type or too big.
 * No upload request happens here — onFileSelected just hands the raw
 * File object up to the caller.
 *
 * Props:
 *   onFileSelected(file | null) — called with the File once it passes
 *                                  validation, or null when cleared
 *   accept       — extension to accept, default '.json'
 *   maxSizeMB    — max file size in MB, default 10
 */
export default function DropZone({ onFileSelected, accept = '.json', maxSizeMB = 10 }) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const visualState = error ? 'error' : selectedFile ? 'fileSelected' : isDragging ? 'dragging' : 'idle';

  const validateFile = (file) => {
    const extension = `.${file.name.split('.').pop()?.toLowerCase()}`;
    if (extension !== accept.toLowerCase()) {
      return `Only ${accept} files are allowed`;
    }
    const maxBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxBytes) {
      return `File must be under ${maxSizeMB}MB`;
    }
    return null;
  };

  const acceptFile = (file) => {
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      setSelectedFile(null);
      onFileSelected?.(null);
      return;
    }
    setError(null);
    setSelectedFile(file);
    onFileSelected?.(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  };

  const handleInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) acceptFile(file);
  };

  const handleZoneClick = () => {
    if (!selectedFile) inputRef.current?.click();
  };

  const handleRemove = (e) => {
    e.stopPropagation();
    setSelectedFile(null);
    setError(null);
    onFileSelected?.(null);
    if (inputRef.current) inputRef.current.value = ''; // allow re-selecting the same file
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleZoneClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleZoneClick();
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer ${STATE_STYLES[visualState]}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleInputChange}
        />

        {selectedFile ? (
          <div
            className="inline-flex items-center gap-3 rounded-md border border-surface-border bg-white px-4 py-2 shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-sm font-medium text-gray-800 truncate max-w-[220px]">
              {selectedFile.name}
            </span>
            <span className="text-xs text-gray-400 shrink-0">
              {formatFileSize(selectedFile.size)}
            </span>
            <button
              type="button"
              onClick={handleRemove}
              aria-label="Remove selected file"
              className="shrink-0 h-5 w-5 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              ×
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-gray-700">
              {isDragging ? 'Drop the file here' : 'Drag & drop a file here, or click to browse'}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {accept} files up to {maxSizeMB}MB
            </p>
          </>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
