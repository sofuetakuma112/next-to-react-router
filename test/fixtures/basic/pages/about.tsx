import dynamic from 'next/dynamic';
import Script from 'next/script';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';

const Chart = dynamic(() => import('../components/Chart'), { ssr: false, loading: () => <p>Loading chart…</p> });

export default function About() {
    const { query } = useRouter();

    return (
        <main>
            <h1>About</h1>
            <p data-testid="from">{query.from ?? 'direct'}</p>
            <Chart points={[1, 2, 3]} />
            <Script id="about-inline">{`window.__aboutRuns = (window.__aboutRuns || 0) + 1;`}</Script>
        </main>
    );
}

About.getLayout = function getLayout(page: React.ReactElement) {
    return <Layout>{page}</Layout>;
};
