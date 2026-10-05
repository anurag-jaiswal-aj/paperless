import { useEffect, useState } from 'react';

const SECTIONS = [
  { id: 'landing-hero', label: 'Go to Hero' },
  { id: 'landing-workflow', label: 'Go to Workflow' },
  { id: 'landing-creation', label: 'Go to Creation Intelligence' },
  { id: 'landing-response', label: 'Go to Response Intelligence' },
  { id: 'landing-overview', label: 'Go to Overview' },
  { id: 'landing-footer', label: 'Go to Footer' },
];

const LandingSectionNav = () => {
  const [activeSection, setActiveSection] = useState('landing-hero');

  useEffect(() => {
    const sectionRatios = {};

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          sectionRatios[entry.target.id] = entry.intersectionRatio;
        });

        let maxRatio = 0;
        let bestMatch = activeSection;

        SECTIONS.forEach(({ id }) => {
          const ratio = sectionRatios[id] || 0;
          if (ratio > maxRatio) {
            maxRatio = ratio;
            bestMatch = id;
          }
        });

        if (maxRatio > 0) {
          setActiveSection(bestMatch);
        }
      },
      {
        rootMargin: '-10% 0px -10% 0px',
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
      }
    );

    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [activeSection]);

  // A secondary scroll listener specifically for the footer if it's too short to have a high intersection ratio
  useEffect(() => {
    const handleScroll = () => {
      const isAtBottom = window.innerHeight + Math.round(window.scrollY) >= document.body.offsetHeight - 10;
      if (isAtBottom) {
        setActiveSection('landing-footer');
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ 
        behavior: prefersReducedMotion ? 'instant' : 'smooth',
        block: 'start'
      });
    }
  };

  const activeSectionIndex = SECTIONS.findIndex(s => s.id === activeSection);

  return (
    <nav 
      aria-label="Page Sections"
      className="hidden md:flex fixed right-[32px] top-1/2 -translate-y-1/2 flex-col items-center z-[9998] pointer-events-auto"
    >
      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(0.5); opacity: 0.8; }
          100% { transform: scale(1); opacity: 0; }
        }
      `}</style>
      {SECTIONS.map((section, index) => {
        const isCurrent = index === activeSectionIndex;
        const isCompleted = index < activeSectionIndex;
        const isLast = index === SECTIONS.length - 1;
        
        let dotClasses = 'rounded-full transition-all duration-300 ';
        if (isCurrent) {
          dotClasses += 'w-2 h-2 bg-[var(--stitch-primary)]';
        } else if (isCompleted) {
          dotClasses += 'w-1.5 h-1.5 bg-[var(--stitch-primary)] group-hover:scale-125';
        } else {
          dotClasses += 'w-1.5 h-1.5 bg-[var(--stitch-outline-variant)] group-hover:bg-[var(--stitch-secondary)] group-hover:scale-125';
        }

        const isLineDark = index < activeSectionIndex;
        const lineClasses = `w-px h-4 transition-colors duration-300 my-0.5 ${isLineDark ? 'bg-[var(--stitch-primary)]' : 'bg-[var(--stitch-outline-variant)]'}`;

        return (
          <div key={section.id} className="flex flex-col items-center">
            <button
              onClick={() => scrollToSection(section.id)}
              aria-label={section.label}
              aria-current={isCurrent ? 'true' : 'false'}
              className="relative w-6 h-6 flex items-center justify-center rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-stitch-primary focus-visible:ring-offset-2 focus-visible:ring-offset-stitch-surface-container-lowest group"
            >
              {isCurrent && (
                <div 
                  className="absolute w-[24px] h-[24px] rounded-full border border-[var(--stitch-primary)] opacity-50 scale-90 motion-safe:animate-[pulse-ring_2s_cubic-bezier(0.2,0,0.8,1)_infinite]"
                  aria-hidden="true"
                />
              )}
              <div 
                className={dotClasses}
                aria-hidden="true"
              />
            </button>
            
            {/* Connecting Line */}
            {!isLast && (
              <div 
                className={lineClasses}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </nav>
  );
};

export default LandingSectionNav;
