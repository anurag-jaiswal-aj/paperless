import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FiChevronDown, FiCheck } from 'react-icons/fi';

const CustomSelect = ({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  ariaLabel,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState({});
  
  const containerRef = useRef(null);
  const listboxRef = useRef(null);
  const triggerRef = useRef(null);

  const selectedOption = options.find((opt) => opt.value === value) || null;

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setFocusedIndex(-1);
  }, []);

  const updatePosition = useCallback(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 4;
    const viewportHeight = window.innerHeight;
    
    const availableBelow = viewportHeight - rect.bottom;
    const availableAbove = rect.top;
    
    const desiredMaxHeight = 240;
    
    const maxMenuWidth = 320;
    const maxAvailableWidth = window.innerWidth - rect.left - 8;
    
    let style = {
      left: `${rect.left}px`,
      minWidth: `${rect.width}px`,
      maxWidth: `${Math.max(rect.width, Math.min(maxMenuWidth, maxAvailableWidth))}px`,
      width: 'max-content'
    };

    if (availableBelow >= desiredMaxHeight || availableBelow > availableAbove) {
      style.top = `${rect.bottom + gap}px`;
      style.maxHeight = `${Math.max(Math.min(availableBelow - gap * 2, desiredMaxHeight), 50)}px`;
    } else {
      style.bottom = `${viewportHeight - rect.top + gap}px`;
      style.maxHeight = `${Math.max(Math.min(availableAbove - gap * 2, desiredMaxHeight), 50)}px`;
    }

    setMenuStyle(style);
  }, [isOpen]);

  const toggleMenu = () => {
    if (disabled) return;
    setIsOpen((prev) => !prev);
    if (!isOpen) {
      const selectedIndex = options.findIndex((opt) => opt.value === value);
      setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  };

  const selectOption = (opt) => {
    console.log('[CustomSelect DEBUG] selectOption called with:', opt);
    console.log('[CustomSelect DEBUG] current value is:', value);
    onChange(opt.value);
    closeMenu();
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      const clickedInContainer = containerRef.current && containerRef.current.contains(e.target);
      const clickedInListbox = listboxRef.current && listboxRef.current.contains(e.target);
      
      if (!clickedInContainer && !clickedInListbox) {
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
    };
  }, [closeMenu]);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);
      return () => {
        window.removeEventListener('scroll', updatePosition, true);
        window.removeEventListener('resize', updatePosition);
      };
    }
  }, [isOpen, updatePosition]);

  const handleKeyDown = (e) => {
    if (disabled) return;

    switch (e.key) {
      case 'Enter':
      case ' ':
        if (isOpen) {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < options.length) {
            selectOption(options[focusedIndex]);
          }
        } else {
          e.preventDefault();
          toggleMenu();
        }
        break;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          closeMenu();
        }
        break;
      case 'ArrowDown':
        if (isOpen) {
          e.preventDefault();
          setFocusedIndex((prev) => (prev < options.length - 1 ? prev + 1 : prev));
        } else {
          e.preventDefault();
          toggleMenu();
        }
        break;
      case 'ArrowUp':
        if (isOpen) {
          e.preventDefault();
          setFocusedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        } else {
          e.preventDefault();
          toggleMenu();
        }
        break;
      case 'Tab':
        if (isOpen) {
          closeMenu();
        }
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (isOpen && listboxRef.current && focusedIndex >= 0) {
      const optionElement = listboxRef.current.children[focusedIndex];
      if (optionElement && typeof optionElement.scrollIntoView === 'function') {
        optionElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [isOpen, focusedIndex]);

  const menuContent = isOpen ? (
    <ul
      role="listbox"
      ref={listboxRef}
      style={{
        position: 'fixed',
        ...menuStyle,
        zIndex: 9999
      }}
      className="overflow-auto rounded-md shadow-lg border border-gray-200 dark:border-[#2A2A2A] bg-white dark:bg-[#181818] py-1 focus:outline-none m-0 list-none"
    >
      {options.map((opt, idx) => {
        const isSelected = opt.value === value;
        const isFocused = idx === focusedIndex;

        return (
          <li
            key={opt.value}
            role="option"
            aria-selected={isSelected}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              selectOption(opt);
            }}
            onClick={(e) => {
              e.stopPropagation();
              selectOption(opt);
            }}
            onMouseEnter={() => setFocusedIndex(idx)}
            className={`relative flex items-center justify-between px-3 py-2 text-sm cursor-pointer theme-transition select-none ${
              isFocused ? 'bg-gray-100 dark:bg-[#222222]' : ''
            } ${isSelected ? 'font-medium bg-gray-50 dark:bg-[#222222]' : ''} text-gray-900 dark:text-[#F5F5F5]`}
          >
            <span className="whitespace-nowrap overflow-visible text-clip pr-4">{opt.label}</span>
            {isSelected && <FiCheck className="w-4 h-4 text-gray-900 dark:text-[#F5F5F5] shrink-0" />}
          </li>
        );
      })}
    </ul>
  ) : null;

  return (
    <div
      ref={containerRef}
      className={`relative inline-block text-left ${className}`}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={triggerRef}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel || placeholder}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={toggleMenu}
        className={`flex items-center justify-between min-w-[140px] px-3 py-1.5 rounded cursor-pointer border theme-transition select-none ${
          disabled
            ? 'opacity-50 cursor-not-allowed bg-gray-100 dark:bg-[#181818] border-gray-200 dark:border-[#2A2A2A]'
            : 'bg-white dark:bg-[#1C1C1C] border-gray-200 dark:border-[#2A2A2A] hover:border-gray-300 dark:hover:border-[#333333]'
        } focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500`}
      >
        <span className="truncate text-sm text-gray-900 dark:text-[#F5F5F5] mr-2">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <FiChevronDown className="w-4 h-4 opacity-50 shrink-0 text-gray-900 dark:text-[#F5F5F5]" />
      </div>

      {typeof document !== 'undefined' && menuContent ? createPortal(menuContent, document.body) : null}
    </div>
  );
};

export default CustomSelect;
