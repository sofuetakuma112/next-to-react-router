import type { GetStaticProps } from 'next';
import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import logo from '../assets/logo.png';
import Layout from '../components/Layout';
import { allPosts, type Post } from '../lib/posts';
import type { NextPageWithLayout } from './_app';

interface HomeProps {
    title: string;
    posts: Post[];
}

const Home: NextPageWithLayout<HomeProps> = ({ title, posts }) => {
    return (
        <main>
            <Head>
                <title>{title}</title>
                <meta name="description" content="Fixture home page" />
            </Head>
            <h1>{process.env.NEXT_PUBLIC_SITE_NAME}</h1>
            <Image src={logo} alt="logo" />
            <Image src="/hero.png" alt="hero" width={320} height={160} priority />
            <ul>
                {posts.map((post) => (
                    <li key={post.id}>
                        <Link href={`/posts/${post.id}`}>{post.title}</Link>
                    </li>
                ))}
            </ul>
        </main>
    );
};

Home.getLayout = (page) => <Layout>{page}</Layout>;

export const getStaticProps: GetStaticProps<HomeProps> = async () => {
    return { props: { title: 'Fixture home', posts: allPosts() } };
};

export default Home;
