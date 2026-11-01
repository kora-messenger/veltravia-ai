import { describe, expect, it } from 'vitest';

import { classifyFrontendStructure } from './structure.js';

describe('frontend structure classification', () => {
  it('groups a component-based project into logical sections', () => {
    const structure = classifyFrontendStructure({
      framework: 'react',
      files: [
        { path: 'src/pages/DashboardPage.tsx', size: 100 },
        { path: 'src/pages/LoginPage.tsx', size: 90 },
        { path: 'src/components/Button.tsx', size: 40 },
        { path: 'src/components/ui/Card.tsx', size: 30 },
        { path: 'src/layouts/AppLayout.tsx', size: 20 },
        { path: 'src/hooks/useAuth.ts', size: 10 },
        { path: 'src/styles/global.css', size: 5 },
        { path: 'public/logo.svg', size: 2 },
        { path: 'src/lib/format.ts', size: 3 },
        { path: 'package.json', size: 1 },
      ],
    });

    expect(structure.layout).toBe('component-based');
    expect(structure.pages).toEqual(['src/pages/DashboardPage.tsx', 'src/pages/LoginPage.tsx']);
    expect(structure.components).toEqual([
      'src/components/Button.tsx',
      'src/components/ui/Card.tsx',
    ]);
    const byId = new Map(structure.sections.map((section) => [section.section, section]));
    expect(byId.get('layouts')?.count).toBe(1);
    expect(byId.get('hooks')?.count).toBe(1);
    expect(byId.get('styles')?.count).toBe(1);
    expect(byId.get('assets')?.count).toBe(1);
    expect(byId.get('utils')?.count).toBe(1);
    expect(byId.get('other')?.count).toBe(1);
    expect(structure.totals).toEqual({ files: 10, bytes: 301 });
  });

  it('recognizes a page by name even when it lives outside a pages directory', () => {
    const structure = classifyFrontendStructure({
      framework: 'nextjs',
      files: [{ path: 'app/settings/PricingPage.tsx' }, { path: 'app/about/page.tsx' }],
    });
    expect(structure.pages).toEqual(['app/about/page.tsx', 'app/settings/PricingPage.tsx']);
  });

  it('uses Flutter vocabulary for a Flutter project', () => {
    const structure = classifyFrontendStructure({
      framework: 'flutter',
      files: [
        { path: 'lib/screens/home_screen.dart' },
        { path: 'lib/widgets/app_card.dart' },
        { path: 'lib/theme/app_theme.dart' },
        { path: 'assets/images/hero.png' },
      ],
    });
    expect(structure.layout).toBe('flutter');
    expect(structure.pages).toEqual(['lib/screens/home_screen.dart']);
    expect(structure.components).toEqual(['lib/widgets/app_card.dart']);
    const byId = new Map(structure.sections.map((section) => [section.section, section]));
    expect(byId.get('styles')?.count).toBe(1);
    expect(byId.get('assets')?.count).toBe(1);
  });

  it('stays neutral rather than assuming React when the stack is unknown', () => {
    const structure = classifyFrontendStructure({
      framework: null,
      files: [{ path: 'src/components/Header.tsx' }, { path: 'src/anything.ts' }],
    });
    expect(structure.layout).toBe('neutral');
    expect(structure.framework).toBeNull();
    expect(structure.components).toEqual(['src/components/Header.tsx']);
  });

  it('caps how many files each section lists while counting them all', () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      path: `src/pages/Page${index}.tsx`,
    }));
    const structure = classifyFrontendStructure({ framework: 'react', files, perSectionLimit: 3 });
    const pages = structure.sections.find((section) => section.section === 'pages');
    expect(pages?.count).toBe(7);
    expect(pages?.files).toHaveLength(3);
    expect(pages?.omitted).toBe(4);
  });

  it('is deterministic and ignores an empty path', () => {
    const files = [{ path: 'src/pages/a.tsx' }, { path: '' }, { path: 'src/pages/b.tsx' }];
    const first = classifyFrontendStructure({ framework: 'react', files });
    const second = classifyFrontendStructure({ framework: 'react', files });
    expect(first).toEqual(second);
    expect(first.totals.files).toBe(2);
  });
});
