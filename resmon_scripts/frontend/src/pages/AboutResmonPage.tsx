import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import TutorialsTab from '../components/AboutResmon/TutorialsTab';
import IssuesTab from '../components/AboutResmon/IssuesTab';
import BlogTab from '../components/AboutResmon/BlogTab';
import AboutAppTab from '../components/AboutResmon/AboutAppTab';

const AboutResmonPage: React.FC = () => {
  return (
    <div className="page-content">
      <div className="page-header">
        <h1>About resmon</h1>
      </div>
      <div className="settings-nav">
        <NavLink to="/about-resmon/tutorials" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Tutorials</NavLink>
        <NavLink to="/about-resmon/issues" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Issues</NavLink>
        <NavLink to="/about-resmon/blog" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Blog</NavLink>
        <NavLink to="/about-resmon/about-app" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>About App</NavLink>
      </div>
      <Routes>
        <Route index element={<Navigate to="tutorials" replace />} />
        <Route path="tutorials" element={<TutorialsTab />} />
        <Route path="issues" element={<IssuesTab />} />
        <Route path="blog" element={<BlogTab />} />
        <Route path="about-app" element={<AboutAppTab />} />
      </Routes>
    </div>
  );
};

export default AboutResmonPage;
