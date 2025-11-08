const Loader = ({ size = 'md' }) => {
  const sizes = {
    sm: 'h-4 w-4',
    md: 'h-8 w-8',
    lg: 'h-12 w-12'
  };

  return (
    <div className="flex justify-center items-center p-4">
      <div className={`${sizes[size]} border-4 border-current border-t-transparent rounded-full animate-spin`}></div>
    </div>
  );
};

export default Loader;
