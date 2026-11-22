import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './Layout.module.css';

export default function Layout({ children }: { children: ReactNode }) {
    return (
        <div className={styles.shell}>
            <nav>
                <Link href="/">Home</Link> <Link href={{ pathname: '/about', query: { from: 'nav' } }}>About</Link>
            </nav>
            {children}
        </div>
    );
}
