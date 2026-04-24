import React from 'react';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  return <main className="main-content">{children}</main>;
};

export default MainContent;
