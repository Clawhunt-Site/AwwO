import { useState, useCallback } from 'react';

interface ProgressiveImageProps {
  src: string;
  thumbSrc?: string;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
}

function deriveThumbSrc(src: string): string {
  return src.replace('.webp', '_thumb.webp');
}

export default function ProgressiveImage({
  src,
  thumbSrc,
  alt,
  className,
  loading = 'lazy',
  fetchPriority,
}: ProgressiveImageProps) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const thumb = thumbSrc ?? deriveThumbSrc(src);

  const handleLoad = useCallback(() => {
    setFullLoaded(true);
  }, []);

  return (
    <div className={`relative overflow-hidden ${className ?? ''}`}>
      <img
        className={`absolute inset-0 w-full h-full object-cover blur-[20px] scale-110 transition-opacity duration-300 ease-in-out ${fullLoaded ? 'opacity-0 pointer-events-none' : ''}`}
        src={thumb}
        alt=""
        aria-hidden="true"
      />
      <img
        className={`w-full h-full object-cover transition-opacity duration-300 ease-in-out ${fullLoaded ? 'opacity-100' : 'opacity-0'}`}
        src={src}
        alt={alt}
        loading={loading}
        fetchPriority={fetchPriority}
        onLoad={handleLoad}
      />
    </div>
  );
}
