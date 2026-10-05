import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

const PencilCursor = () => {
  const cursorRef = useRef(null);
  const [isVisible] = useState(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  const { theme } = useSelector((state) => state.theme);

  useEffect(() => {
    if (!isVisible) return;

    const handleMouseMove = (e) => {
      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
      }
    };
    
    // Use passive listener for better performance
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isVisible]);

  if (!isVisible) return null;

  const isDark = theme === 'dark';
  
  // Theme logic for proper contrast
  const primaryFill = isDark ? '#ffffff' : '#09090b';
  const strokeColor = isDark ? '#09090b' : '#ffffff';
  
  // Neutral materials for realism while staying monochrome/clean
  const woodFill = isDark ? '#3f3f46' : '#e4e4e7'; // zinc-700 / zinc-200
  const ferruleFill = isDark ? '#71717a' : '#a1a1aa'; // zinc-500 / zinc-400
  const eraserFill = isDark ? '#a1a1aa' : '#52525b'; // zinc-400 / zinc-600

  return (
    <div
      ref={cursorRef}
      className="fixed top-0 left-0 pointer-events-none z-[10000]"
      style={{
        transform: 'translate3d(-100px, -100px, 0)',
        willChange: 'transform'
      }}
      aria-hidden="true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="42"
        height="42"
        viewBox="0 0 48 48"
        style={{
          transform: 'translate(-5.25px, -36.75px)'
        }}
      >
        <g stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {/* Eraser */}
          <path d="M 25 15 L 29 11 A 6 6 0 0 1 37 19 L 33 23 Z" fill={eraserFill} />
          
          {/* Ferrule */}
          <polygon points="22,18 25,15 33,23 30,26" fill={ferruleFill} />
          <line x1="23.5" y1="16.5" x2="31.5" y2="24.5" />
          
          {/* Body */}
          <polygon points="10,30 22,18 30,26 18,38" fill={primaryFill} />
          <line x1="14" y1="34" x2="26" y2="22" />
          
          {/* Wood Section */}
          <polygon points="7.5,37.5 10,30 18,38 10.5,40.5" fill={woodFill} />
          
          {/* Graphite Tip */}
          <polygon points="6,42 7.5,37.5 10.5,40.5" fill={primaryFill} />
        </g>
      </svg>
    </div>
  );
};

export default PencilCursor;
