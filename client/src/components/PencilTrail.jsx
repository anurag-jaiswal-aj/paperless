import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';

// Helper for smooth spline interpolation
const getCatmullRomPoint = (t, p0, p1, p2, p3) => {
  const t2 = t * t;
  const t3 = t2 * t;
  const x = 0.5 * ((2 * p1.x) +
                   (-p0.x + p2.x) * t +
                   (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                   (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const y = 0.5 * ((2 * p1.y) +
                   (-p0.y + p2.y) * t +
                   (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                   (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  return { x, y };
};

const PencilTrail = () => {
  const canvasRef = useRef(null);
  const pointsRef = useRef([]);
  const requestRef = useRef(null);
  
  // Subscribe to theme to ensure re-renders/syncing if needed
  useSelector((state) => state.theme.theme);

  useEffect(() => {
    // Only enable on devices with a fine pointer (mouse/stylus)
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      return;
    }
    
    // Respect user's motion preferences
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    let width = window.innerWidth;
    let height = window.innerHeight;
    
    const setCanvasSize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
    };
    
    setCanvasSize();
    window.addEventListener('resize', setCanvasSize);

    const handleMouseMove = (e) => {
      const newPoint = { x: e.clientX, y: e.clientY, timestamp: Date.now() };
      const points = pointsRef.current;
      
      if (points.length > 0) {
        const lastPoint = points[points.length - 1];
        const dist = Math.hypot(newPoint.x - lastPoint.x, newPoint.y - lastPoint.y);
        // Break stroke on massive pointer jumps (e.g. leaving window and entering elsewhere)
        if (dist > 300) {
          pointsRef.current = [];
        }
      }
      
      pointsRef.current.push(newPoint);
      
      // Bounded array to prevent memory leaks during rapid movement
      if (pointsRef.current.length > 200) {
        pointsRef.current.shift();
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    const LIFETIME = 1800; // Stroke vanishes after 1.8 seconds
    
    const animate = () => {
      ctx.clearRect(0, 0, width, height);
      
      const now = Date.now();
      const points = pointsRef.current;
      
      // Remove expired points
      while (points.length > 0 && now - points[0].timestamp > LIFETIME) {
        points.shift();
      }
      
      if (points.length > 1) {
        const isDarkTheme = document.documentElement.classList.contains('dark');
        const rgb = isDarkTheme ? '255, 255, 255' : '9, 9, 11';
        
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2; // Subtle pencil width
        
        // 1. Generate dense smoothed points using Catmull-Rom spline
        const smoothPoints = [];
        if (points.length > 2) {
          for (let i = 0; i < points.length - 1; i++) {
            const p0 = i === 0 ? points[0] : points[i - 1];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = i + 2 < points.length ? points[i + 2] : p2;
            
            const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const steps = Math.max(1, Math.floor(dist / 3)); // Sample every 3 pixels for smoothness
            
            for (let j = 0; j < steps; j++) {
              const t = j / steps;
              const pt = getCatmullRomPoint(t, p0, p1, p2, p3);
              pt.timestamp = p1.timestamp + (p2.timestamp - p1.timestamp) * t;
              smoothPoints.push(pt);
            }
          }
          smoothPoints.push(points[points.length - 1]);
        } else {
          smoothPoints.push(...points);
        }

        // 2. Group dense points into subpaths by quantized opacity to prevent overlap artifacts
        const subpaths = [];
        let currentPath = [];
        const opacityStep = 0.02; // Group into ~20 opacity buckets
        let currentOpacityQuantized = -1;

        for (let i = 0; i < smoothPoints.length; i++) {
          const p = smoothPoints[i];
          const age = now - p.timestamp;
          const lifeProgress = Math.max(0, 1 - (age / LIFETIME));
          const rawOpacity = lifeProgress * lifeProgress * 0.4; // Max 40% opacity, squared easing
          const quantized = Math.floor(rawOpacity / opacityStep) * opacityStep;
          
          if (quantized !== currentOpacityQuantized && currentPath.length > 0) {
            // Share the boundary point for a seamless connection between subpaths
            currentPath.push(p);
            subpaths.push({ opacity: currentOpacityQuantized, points: currentPath });
            currentPath = [p];
            currentOpacityQuantized = quantized;
          } else {
            currentPath.push(p);
            if (currentOpacityQuantized === -1) currentOpacityQuantized = quantized;
          }
        }
        if (currentPath.length > 0) {
          subpaths.push({ opacity: currentOpacityQuantized, points: currentPath });
        }

        // 3. Render continuous subpaths
        for (const sub of subpaths) {
          if (sub.opacity <= 0.01) continue;
          
          ctx.beginPath();
          ctx.moveTo(sub.points[0].x, sub.points[0].y);
          for (let i = 1; i < sub.points.length; i++) {
            ctx.lineTo(sub.points[i].x, sub.points[i].y);
          }
          ctx.strokeStyle = `rgba(${rgb}, ${sub.opacity})`;
          ctx.stroke();
        }
      }
      
      requestRef.current = requestAnimationFrame(animate);
    };
    
    requestRef.current = requestAnimationFrame(animate);
    
    return () => {
      window.removeEventListener('resize', setCanvasSize);
      window.removeEventListener('mousemove', handleMouseMove);
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed top-0 left-0 w-full h-full pointer-events-none z-[9999]"
      aria-hidden="true"
    />
  );
};

export default PencilTrail;
