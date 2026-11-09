import { Link } from 'react-router-dom';
import { LogoMark } from '../components/Logo';
import { useI18n } from '../i18n';

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page not-found">
      <LogoMark size={64} />
      <p>{t('common.notFound')}</p>
      <Link to="/" className="btn btn-primary">
        {t('common.goHome')}
      </Link>
    </div>
  );
}
