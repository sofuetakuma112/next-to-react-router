import type { GetServerSidePropsContext } from 'next';
import UserCard from '@/components/UserCard';
import '@/styles/user.css';

interface Props {
    name: string;
    tab: string;
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
    const tab = typeof context.query.tab === 'string' ? context.query.tab : 'profile';
    return { props: { name: `User ${context.params?.id}`, tab } };
}

export default function UserPage({ name, tab }: Props) {
    return (
        <main>
            <UserCard name={name} />
            <p data-testid="tab">{tab}</p>
        </main>
    );
}
