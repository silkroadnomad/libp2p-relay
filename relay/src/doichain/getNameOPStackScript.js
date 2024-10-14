import { address, script } from 'bitcoinjs-lib';

export const NAME_MAX_LENGTH = 255
export const VALUE_MAX_LENGTH = 520

const ERRORS = {
    NAME_ID_DEFINED: "nameId and nameValue must be defined",
    NAME_ID_LENGTH: `nameId must be at least 3 characters and not longer than ${NAME_MAX_LENGTH}`,
    NAME_VALUE_LENGTH: `nameValue must not be longer than ${VALUE_MAX_LENGTH}`,
    INVALID_ADDRESS: "Invalid recipient address: "
};

/**
 * Creates a NameOPStackScript from a nameId, nameValue, and recipientAddress
 * Reference implementations:
 * - https://github.com/brandonrobertz/bitcore-namecoin/blob/master/lib/names.js
 * - https://github.com/doichain/doichain-transaction
 *
 * @param {string} nameId - The identifier for the ipnsInstance.
 * @param {string} nameValue - The value associated with the ipnsInstance.
 * @param {string} recipientAddress - The recipient's Doichain address.
 * @param {string} network - The Doichain network (e.g., 'mainent', 'testnet', 'regtest').
 * @returns {Buffer} The compiled script as a Buffer.
 */
export const getNameOPStackScript = (nameId, nameValue, recipientAddress, network) => {
    if (!nameId || nameValue===undefined) {
        throw new Error(ERRORS.NAME_ID_DEFINED);
    }

    if (nameId.length > NAME_MAX_LENGTH || nameId.length < 3) {
        throw new Error(ERRORS.NAME_ID_LENGTH);
    }

    if (nameValue.length > VALUE_MAX_LENGTH) {
        throw new Error(ERRORS.NAME_VALUE_LENGTH);
    }

    const op_name = Buffer.from(nameId).toString('hex');
    const op_value = Buffer.from(nameValue).toString('hex');

    let op_address;
    // try {
        let decoded;
        try {
            decoded = address.fromBase58Check(recipientAddress);
            op_address = decoded.hash.toString('hex');
        } catch (legacyError) {
            try {
                decoded = address.fromBech32(recipientAddress);
                console.log("decoded",decoded)
                op_address = decoded.data.toString('hex');
                console.log("op_address",op_address)
            } catch (segwitError) {
                throw new Error(ERRORS.INVALID_ADDRESS + legacyError.message + " or " + segwitError.message);
            }
        }
    // } catch (error) {
    //     console.log("")
    //     //throw new Error(ERRORS.INVALID_ADDRESS + error.message);
    // }

    const opCodesStackScript = script.fromASM(
      `
                                              OP_10
                                              ${op_name}
                                              ${op_value}
                                              OP_2DROP
                                              OP_DROP
                                              OP_DUP
                                              OP_HASH160
                                              ${op_address}
                                              OP_EQUALVERIFY
                                              OP_CHECKSIG
                                        `.trim().replace(/\s+/g, ' '),
    )
    return opCodesStackScript;
};
