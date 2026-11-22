import type { ReactNode } from 'react';
import './PageLayout.css';

/** 页面标题、说明与正文插槽。 Page heading, description, and content slot. */
interface PageLayoutProps {
  /** 由页面提供的当前语言标题。 Heading in the current language, supplied by the page. */
  title: string;
  /** 由页面提供的当前语言说明。 Description in the current language, supplied by the page. */
  description: string;
  /** 由当前路由页面组织的业务内容。 Feature content composed by the current routed page. */
  children?: ReactNode;
}

/**
 * 统一业务页面的标题和正文宽度。页面负责提供翻译后的文本和内容。
 * Keep the heading and content width consistent. Each page supplies translated text and content.
 *
 * @param props 页面标题、说明及可选正文。 Page heading, description, and optional content.
 * @returns 可放入应用正文的页面区块。 Page section for the application's main content.
 */
export function PageLayout({ title, description, children }: PageLayoutProps) {
  return (
    <section className="page-layout">
      <header className="page-heading">
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}
