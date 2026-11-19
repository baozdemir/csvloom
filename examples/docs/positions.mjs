import { formatError, parseDetailed } from 'csvloom';

const text = 'id,name,city\n1,Ada,London\n2,Grace\n3,Linus,"Helsinki\n';
const { errors } = parseDetailed(text, { header: true, positions: true });
for (const error of errors) console.log(formatError(error));
