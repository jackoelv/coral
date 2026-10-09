// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {FreeDaoNFT} from "../src/FreeDaoNFT.sol";
import {IERC4906} from "../lib/openzeppelin-contracts/contracts/interfaces/IERC4906.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Base64} from "../lib/openzeppelin-contracts/contracts/utils/Base64.sol";

contract FreeDaoNFTTest is CoralIdoBase {
    string constant IMAGE = "https://test.freedao.life/media/nomad/rwa-nft-pass.webp";
    string constant IMAGE_V2 = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    function _expectedUri(
        uint256 id,
        string memory image
    ) internal pure returns (string memory) {
        return _expectedUri(id, image, false);
    }

    function _expectedUri(
        uint256 id,
        string memory image,
        bool transferable
    ) internal pure returns (string memory) {
        string memory note = transferable ? "Transferable." : "Non-transferable.";
        string memory flag = transferable ? "Yes" : "No";
        bytes memory json = abi.encodePacked(
            '{"name":"FREEDAO RWA Pass #',
            vm.toString(id),
            '","description":"FREEDAO RWA Pass. ',
            note,
            ' Face value 500 USDT.","image":"',
            image,
            '","attributes":[{"trait_type":"Face value","value":"500 USDT"},',
            '{"trait_type":"Transferable","value":"',
            flag,
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    function test_tokenUriCarriesImage() public {
        vm.prank(owner);
        nft.setImageURI(IMAGE);
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1000 * UNIT);
        assertEq(nft.tokenURI(2), _expectedUri(2, IMAGE));
    }

    function test_ownerReplacesImageForMintedTokens() public {
        vm.prank(owner);
        nft.setImageURI(IMAGE);
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1000 * UNIT);

        vm.expectEmit(address(nft));
        emit FreeDaoNFT.ImageURIUpdated(IMAGE_V2);
        vm.expectEmit(address(nft));
        emit IERC4906.BatchMetadataUpdate(1, 2);
        vm.prank(owner);
        nft.setImageURI(IMAGE_V2);

        assertEq(nft.imageURI(), IMAGE_V2);
        assertEq(nft.tokenURI(1), _expectedUri(1, IMAGE_V2));
    }

    function test_strangerCannotSetImage() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        nft.setImageURI(IMAGE);
    }

    function test_rejectsImageThatBreaksJson() public {
        vm.startPrank(owner);
        vm.expectRevert(FreeDaoNFT.InvalidImageURI.selector);
        nft.setImageURI("");
        vm.expectRevert(FreeDaoNFT.InvalidImageURI.selector);
        nft.setImageURI('https://x/"a');
        vm.expectRevert(FreeDaoNFT.InvalidImageURI.selector);
        nft.setImageURI("https://x/\\a");
        vm.expectRevert(FreeDaoNFT.InvalidImageURI.selector);
        nft.setImageURI("https://x/\na");
        vm.stopPrank();
    }

    function test_tokenUriRevertsForUnminted() public {
        vm.expectRevert();
        nft.tokenURI(1);
    }

    function test_supportsMetadataUpdateInterface() public view {
        assertTrue(nft.supportsInterface(0x49064906));
        assertTrue(nft.supportsInterface(0x80ac58cd));
    }

    function test_oneDeposit500MintsNone() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 500 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftMinted(alice), 0);
        assertEq(ido.nftDeferred(alice), 0);
        assertEq(ido.nftRemainder(alice), 0);
    }

    function test_oneDeposit1000MintsTwo() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1000 * UNIT);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(ido.nftMinted(alice), 2);
        assertEq(ido.nftRemainder(alice), 0);
    }

    function test_oneDeposit1500MintsThree() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1500 * UNIT);
        assertEq(nft.balanceOf(alice), 3);
        assertEq(ido.nftMinted(alice), 3);
        assertEq(ido.nftRemainder(alice), 0);
    }

    function test_oneDeposit1200MintsTwo() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1200 * UNIT);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(ido.nftRemainder(alice), 200 * UNIT);
    }

    function test_split250Plus250MintsOnSecond() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 250 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftRemainder(alice), 250 * UNIT);
        _contribute(alice, 250 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftRemainder(alice), 0);
    }

    function test_remainder400Then100MintsSecond() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 400 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        _contribute(alice, 500 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftRemainder(alice), 400 * UNIT);
        _contribute(alice, 100 * UNIT);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(ido.nftRemainder(alice), 0);
    }

    function test_soulboundCannotTransfer() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1000 * UNIT);
        uint256 id = 1;
        assertEq(nft.ownerOf(id), alice);
        vm.prank(alice);
        vm.expectRevert(FreeDaoNFT.TransfersLocked.selector);
        nft.transferFrom(alice, bob, id);
        vm.prank(alice);
        nft.approve(bob, id);
        vm.prank(bob);
        vm.expectRevert(FreeDaoNFT.TransfersLocked.selector);
        nft.transferFrom(alice, bob, id);
    }

    function test_ownerCanEnableAndDisableTransfers() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1000 * UNIT);
        uint256 id = 1;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        nft.setTransfersEnabled(true);

        vm.expectEmit(address(nft));
        emit FreeDaoNFT.TransfersEnabledUpdated(true);
        vm.expectEmit(address(nft));
        emit IERC4906.BatchMetadataUpdate(1, 2);
        vm.prank(owner);
        nft.setTransfersEnabled(true);
        assertEq(nft.tokenURI(id), _expectedUri(id, "", true));

        vm.prank(alice);
        nft.transferFrom(alice, bob, id);
        assertEq(nft.ownerOf(id), bob);

        vm.prank(owner);
        nft.setTransfersEnabled(false);
        vm.prank(bob);
        vm.expectRevert(FreeDaoNFT.TransfersLocked.selector);
        nft.transferFrom(bob, alice, id);
        assertEq(nft.ownerOf(id), bob);
    }

    function test_strangerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(FreeDaoNFT.NotAuthorized.selector);
        nft.mint(alice, 1);
    }

    function test_directAndNemoUnchanged() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 1000 * UNIT);
        assertEq(_direct(alice), 100 * UNIT);
        assertEq(nemo.balanceOf(bob), 100_000 * UNIT);
        assertEq(nft.balanceOf(bob), 2);
        assertEq(nft.balanceOf(alice), 0);
    }

    function test_importDoesNotMintNft() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](1);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = alice;
        codes[0] = _code("ALICE001");
        ido.importUsers(wallets, codes);
        address[] memory volW = new address[](1);
        uint256[] memory selves = new uint256[](1);
        volW[0] = alice;
        selves[0] = 1000 * UNIT;
        ido.importVolumes(volW, selves);
        ido.freezeImport();
        ido.openSale();
        vm.stopPrank();

        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftMinted(alice), 2);

        _contribute(alice, 100 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(_self(alice), 1100 * UNIT);
        assertEq(ido.nftRemainder(alice), 100 * UNIT);

        _contribute(alice, 400 * UNIT);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(ido.nftMinted(alice), 3);
    }

    function test_import500OccupiesNoNft() public {
        vm.startPrank(owner);
        ido.importUsers(_one(alice), _oneCode("ALICE001"));
        ido.importVolumes(_one(alice), _oneAmount(500 * UNIT));
        vm.stopPrank();
        assertEq(ido.nftMinted(alice), 0);
        assertEq(ido.importedNfts(alice), 0);
        assertEq(ido.nftsAllocated(), 0);
        assertEq(nft.balanceOf(alice), 0);
    }

    function _one(
        address account
    ) internal pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }

    function _oneCode(
        string memory code
    ) internal pure returns (bytes32[] memory codes) {
        codes = new bytes32[](1);
        codes[0] = _code(code);
    }

    function _oneAmount(
        uint256 amount
    ) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = amount;
    }
}
